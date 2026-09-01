import {
  add as addNotif,
  getAll as getNotifs,
  dueForRenag,
  getRenagMinutes,
  bumpNag,
  subscribe as subscribeNotifs,
  type Severity,
  type AppNotification,
} from '@/lib/notifications';
import { getTypePrefs, isMuted, subscribePrefs, type TypePrefs } from '@/lib/prefs';
import type { OtherUser, TicketState, TicketWarnings, PanelToContentMessage } from '@/lib/messaging';
import { renderBanner, removeBanner } from '@/lib/banner';
import { renderInsightWidget, removeInsightWidget } from '@/lib/insight-widget';
import { showNotifToast } from '@/lib/notif-toast';
import { readNameFrom } from '@/lib/identity';
import { IDENTITY_DATASET_KEY, IDENTITY_PUBLISH_WINDOW_MS, IDENTITY_POLL_INTERVAL_MS } from '@/lib/identity-bridge';

export default defineContentScript({
  matches: ['https://*.autotask.net/*'],
  runAt: 'document_idle',
  main() {
    let currentTicketId: string | null = null;
    // Última identidad de presencia realmente registrada en el servidor (número de
    // ticket, o el ID crudo como fallback) — se usa para liberar la presencia correcta
    // al salir/cambiar de ticket, en vez de recalcularla (el título de la página puede
    // ya haber cambiado al nuevo ticket en ese momento).
    let lastPresenceId: string | null = null;
    let pollInterval: number | undefined;
    let pauseTimeout: number | undefined;
    let pauseTickInterval: number | undefined;
    let currentUser: string | null = null;
    let wasLocked = false;
    let soundEnabled = true;
    let lastOthers: OtherUser[] = [];
    let pingCooldown = false;
    let autoPingTimer: number | undefined;
    let autoPingFired = false;
    let AUTO_PING_MINUTES = 5;

    // Configurable desde ajustes del panel lateral. Se invoca al final de main(), no
    // acá: safeChrome() lee variables declaradas más abajo y llamarlo antes daría
    // ReferenceError por la temporal dead zone de `let`.
    function watchAutoPingConfig() {
      safeChrome(() => chrome.storage.local.get(['netsus_auto_ping_min'], (data: any) => {
        if (data.netsus_auto_ping_min) AUTO_PING_MINUTES = Math.max(1, parseInt(data.netsus_auto_ping_min) || 5);
      }));
      safeChrome(() => chrome.storage.onChanged.addListener((changes) => {
        if ('netsus_auto_ping_min' in changes) {
          AUTO_PING_MINUTES = Math.max(1, parseInt(String(changes.netsus_auto_ping_min.newValue)) || 5);
        }
      }));
    }

    let renagTimer: number | undefined;
    let typePrefs: TypePrefs = {};
    // Espejo local del buzón — alimenta la tarjeta embebida (lib/insight-widget.ts).
    // Se mantiene al día vía subscribeNotifs() (chrome.storage.onChanged), sin polling propio.
    let recentNotifs: AppNotification[] = [];
    // ids ya vistos por ESTA instancia — null hasta el primer fetch, para no
    // toastear todo el historial al cargar la página, solo lo que llega después.
    let knownNotifIds: Set<string> | null = null;
    // Tipos que llegan por el poller del background (entrypoints/background.ts,
    // fuera del ciclo de vida de un ticket) y por eso no tienen ya un aviso propio
    // en pantalla — a diferencia de collision/ping/liberation, que si el técnico
    // está en ESE ticket ya se ven en el banner/lock de esa misma vista.
    const TOASTABLE_TYPES = new Set(['n1_queue', 'n2_assign', 'n3_client', 'n4_sla', 'n5_critical']);

    // Estado enviado al side panel por mensajes — el panel ya no vive en el DOM
    // de esta página (el margin-push con CSS no dividía el espacio de verdad en
    // apps con contenedor raíz fixed/vw; el Side Panel nativo de Chrome sí lo hace).
    let currentState: TicketState = { kind: 'idle' };
    let currentWarnings: TicketWarnings = { offline: false, historyCount: null, assignedTo: null, assignedResource: null, statusLabel: null, assignedPresent: false };

    // Estado del banner inyectado en la página (además del side panel) — se resetea
    // por ticket en init(), igual que wasLocked/autoPingFired.
    let bannerMinimized = false;
    let bannerDismissed = false;

    let lastStateSentAt = 0;

    // --- Ciclo de vida de esta instancia ---
    // Un content script no muere cuando se recarga la extensión: sigue vivo en la página
    // pero pierde su puente con ella, y desde ahí CUALQUIER llamada a chrome.* revienta
    // con "Extension context invalidated" — las de chrome.storage además de forma
    // SÍNCRONA, así que un .catch() encadenado no las atrapa. Tampoco muere cuando el
    // background re-inyecta una instancia nueva. En ambos casos hay que apagarla a mano;
    // si no, sus timers siguen corriendo y floodean la consola cada 5 s.
    // `stopped` es la bandera que consultan todos los guards de abajo.
    let stopped = false;
    let heartbeatInterval: number | undefined;
    let urlObserver: MutationObserver | undefined;

    // chrome.runtime.id queda en undefined en cuanto el contexto muere: es el chequeo
    // canónico y barato para saltarnos la llamada antes de que tire.
    function extensionAlive(): boolean {
      if (stopped) return false;
      try {
        return !!chrome.runtime?.id;
      } catch {
        return false;
      }
    }

    function isContextError(err: unknown): boolean {
      const msg = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
      return msg.includes('Extension context invalidated');
    }

    // Apagado: detiene todo lo que esta instancia tenga andando y limpia lo que dejó
    // en la página. Se usa tanto al morir el contexto como al ser reemplazada por una
    // instancia más nueva.
    function teardown() {
      clearInterval(pollInterval);
      clearInterval(pauseTickInterval);
      clearInterval(renagTimer);
      clearInterval(heartbeatInterval);
      clearTimeout(autoPingTimer);
      clearTimeout(pauseTimeout);
      urlObserver?.disconnect();
      unlockUI();
      removeBanner();
      removeInsightWidget();
    }

    function handleContextInvalidated() {
      if (stopped) return;
      stopped = true;
      teardown();
    }

    // Único punto de entrada a chrome.* desde el content script: si el contexto ya murió
    // no llama, y si muere durante la llamada apaga todo en vez de propagar el error.
    function safeChrome<T>(fn: () => T): T | undefined {
      if (!extensionAlive()) { handleContextInvalidated(); return undefined; }
      try {
        return fn();
      } catch (err) {
        if (isContextError(err)) handleContextInvalidated();
        else throw err;
        return undefined;
      }
    }

    // Red de seguridad a nivel de ventana. Los guards de arriba cubren las llamadas que
    // hacemos nosotros, pero el error también puede nacer dentro de una promesa de
    // lib/*, del wrapper `browser` de WXT, o de una petición que ya estaba en vuelo
    // cuando la extensión se recargó — rutas donde no tenemos dónde poner un .catch().
    // Estos dos listeners atrapan cualquiera de esas y evitan que Chrome las reporte.
    window.addEventListener('unhandledrejection', (e) => {
      if (!isContextError(e.reason)) return;
      e.preventDefault();
      handleContextInvalidated();
    });
    window.addEventListener('error', (e) => {
      if (!isContextError(e.error)) return;
      e.preventDefault();
      handleContextInvalidated();
    });

    // --- Detección inmediata de que la extensión se fue ---
    // Hasta acá solo nos enterábamos en el próximo tick de un timer (hasta 5 s), y en
    // esa ventana cualquier callback en vuelo podía llegar a chrome.* y tirar. Un puerto
    // abierto contra el background se desconecta en el instante en que la extensión se
    // recarga, actualiza o desinstala, así que nos deja apagarnos de inmediato.
    function openLifeline() {
      safeChrome(() => {
        const port = chrome.runtime.connect({ name: 'netsus-lifeline' });
        port.onDisconnect.addListener(() => {
          if (stopped) return;
          // El puerto también se cae si Chrome recicla el service worker por
          // inactividad, y eso NO es motivo para apagarse: en ese caso chrome.runtime.id
          // sigue definido. Queda undefined solo si la extensión se fue de verdad.
          if (!extensionAlive()) { handleContextInvalidated(); return; }
          setTimeout(openLifeline, 1000); // reconectar al SW que Chrome vuelva a levantar
        });
      });
    }

    // --- Relevo de instancias ---
    // Al recargar la extensión, el background re-inyecta este script en las pestañas
    // que ya estaban abiertas, pero la instancia anterior NO muere: sigue con sus
    // timers andando. Quedaban dos corriendo a la vez — doble registro de presencia,
    // doble sonido, doble banner — y la vieja, sin los guards de esta versión,
    // floodeaba la consola hasta que se cerrara la pestaña.
    // Todos los content scripts de una misma extensión comparten el mismo "isolated
    // world", así que un CustomEvent en window llega a las otras instancias.
    // Ojo con el orden: primero avisamos (apaga a la anterior) y recién después nos
    // suscribimos, para no apagarnos con nuestro propio evento.
    const SUPERSEDE_EVENT = 'netsus-coview-supersede';
    window.dispatchEvent(new CustomEvent(SUPERSEDE_EVENT));
    window.addEventListener(SUPERSEDE_EVENT, () => {
      if (stopped) return;
      stopped = true; // frena también los guards de los callbacks en vuelo
      teardown();
    });

    function pushState() {
      const now = Date.now();
      // Durante la pausa, el sidepanel tiene su propio timer local — solo sincronizamos
      // cada 5 s para no despertar el SW 60 veces por minuto (eso provoca throttling).
      const isPaused = currentState.kind === 'paused';
      if (!isPaused || now - lastStateSentAt >= 5000) {
        safeChrome(() =>
          chrome.runtime
            .sendMessage({ type: 'NSB_STATE', payload: { state: currentState, warnings: currentWarnings } })
            .catch((err) => { if (isContextError(err)) handleContextInvalidated(); }),
        );
        lastStateSentAt = now;
      }
      // Tarjeta embebida en la columna nativa de Autotask (Organización/Contacto,
      // Resumen de tiempo, Elemento de configuración, ...) — se intenta primero;
      // si Autotask todavía no montó esa columna (o esta vista no la trae),
      // insertedInPage queda false y el pill flotante de banner.ts sigue de respaldo.
      const insertedInPage = renderInsightWidget(
        currentState,
        currentWarnings,
        recentNotifs,
        {
          onPing: () => triggerPing(),
          onFinish: triggerFinish,
          onCancelPause: () => { clearTimeout(pauseTimeout); resumeAfterPause(); },
        },
      );
      renderBanner(
        currentState,
        currentWarnings,
        { minimized: bannerMinimized, dismissed: bannerDismissed, assignedElsewhere: insertedInPage },
        {
          onPing: triggerPing,
          onFinish: triggerFinish,
          onPause: pausePresence,
          onCancelPause: () => { clearTimeout(pauseTimeout); resumeAfterPause(); },
          onToggleMinimize: () => { bannerMinimized = !bannerMinimized; pushState(); },
          onDismiss: () => { bannerDismissed = true; pushState(); },
        },
      );
    }
    function setState(s: TicketState) { currentState = s; pushState(); }
    function setOffline(v: boolean) {
      const prevOffline = currentWarnings.offline;
      currentWarnings = { ...currentWarnings, offline: v };
      pushState();
      // Reconexión automática: si volvemos a conectar, registrar presencia inmediatamente
      if (prevOffline && !v && currentTicketId && currentUser) {
        const p = presenceId();
        if (p) registerPresence(p, currentUser);
      }
    }
    function setHistoryWarning(v: number | null) { currentWarnings = { ...currentWarnings, historyCount: v }; pushState(); }
    function setAssignment(mismatch: string | null, resource: string | null, statusLabel: string | null = null, assignedPresent = false) {
      currentWarnings = { ...currentWarnings, assignedTo: mismatch, assignedResource: resource, statusLabel, assignedPresent };
      pushState();
    }

    function getUserFromDOM(): string | null {
      // Autotask expone el nombre del usuario logueado en window.walkMeData, PERO en
      // el main world de la página. Este content script vive en el isolated world:
      // comparte el DOM, no las globales, así que leer window.walkMeData acá devuelve
      // undefined siempre (en la consola de DevTools sí se ve, porque evalúa en el
      // main world). Por eso entrypoints/walkme-bridge.content.ts corre en el main
      // world y nos deja el nombre en un data-attribute, que sí cruza la pared.
      // El puente valida el valor antes de publicarlo (readNameFrom), pero lo
      // revalidamos acá: el atributo vive en el DOM de la página y cualquier script
      // —de Autotask o de otra extensión— puede escribirlo. No es la frontera de
      // seguridad (esa es sanitizeUser() en el servidor), es no propagar basura.
      const bridged = readNameFrom({
        narrativeFullName: document.documentElement.dataset[IDENTITY_DATASET_KEY],
      });
      if (bridged) return bridged;

      // Firefox se buildea como MV2, donde no hay content scripts en el main world
      // (por eso el puente se excluye de ese build); a cambio deja atravesar el Xray
      // wrapper con wrappedJSObject. En Chrome/Edge esto es undefined y no molesta.
      // NOTA: esta rama no está verificada en un Firefox real — ver README.
      try {
        return readNameFrom((window as any).wrappedJSObject?.walkMeData);
      } catch {
        // Xray/wrappedJSObject no disponible o lanzó — seguimos sin nombre.
        return null;
      }
    }

    // Momento en que esta instancia empezó a buscar identidad. El corte es por TIEMPO
    // y no por número de reintentos para poder compartir presupuesto con el puente
    // (lib/identity-bridge.ts): antes el puente insistía ~20 s y esto dejaba de mirar
    // a los ~16 s, así que un Autotask lento publicaba el nombre cuando ya nadie leía.
    const identitySearchStartedAt = Date.now();

    function loadUserAndInit() {
      safeChrome(() => chrome.storage.local.get(['netsus_user', 'netsus_user_auto', 'netsus_sound'], ({ netsus_user, netsus_user_auto, netsus_sound }: { netsus_user?: string; netsus_user_auto?: boolean; netsus_sound?: string }) => {
        soundEnabled = netsus_sound !== 'off';
        // Intentar siempre auto-detectar desde walkMeData; si fue configurado
        // manualmente se respeta, pero si fue auto-detectado se actualiza.
        const fromDOM = getUserFromDOM();
        if (fromDOM && (!netsus_user || netsus_user_auto)) {
          currentUser = fromDOM;
          safeChrome(() => chrome.storage.local.set({ netsus_user: fromDOM, netsus_user_auto: true }));
          init();
        } else if (netsus_user) {
          currentUser = netsus_user;
          init();
        } else if (Date.now() - identitySearchStartedAt < IDENTITY_PUBLISH_WINDOW_MS) {
          setTimeout(loadUserAndInit, IDENTITY_POLL_INTERVAL_MS);
        } else {
          init();
        }
      }));
    }

    function extractTicketId(): string | null {
      // Ojo: chequear la RUTA, no la URL completa — páginas como "Búsqueda de
      // tickets" pueden llevar un parámetro returnUrl=...TicketDetail... que
      // haría match por substring en la URL completa aunque no sea un ticket.
      // Sin ancla $ para tolerar trailing slash u otros sufijos menores.
      if (!/\/Ticket(?:Edit|Detail)\.mvc/i.test(window.location.pathname)) return null;
      const url = window.location.href;
      const direct = url.match(/[?&]ticketId=(\d+)/i);
      if (direct) return direct[1];
      // Vista "workspace" multi-ticket (paginador "N de M"): la URL usa ids[0]=/ids%5B0%5D=
      // en vez de ticketId=. El primer id de la lista es el ticket actualmente mostrado
      // (confirmado: la lista se reordena al pasar de ticket en ticket, no queda fija).
      const workspace = url.match(/[?&]ids(?:\[0\]|%5[bB]0%5[dD])=(\d+)/i);
      if (workspace) return workspace[1];
      // Fallback: si la URL no tiene parámetros numéricos (ej. id=, path-based),
      // usar el número de ticket del título. presenceId() ya usa extractTicketNumber()
      // para la detección de colisiones, así que el tracking funciona igual.
      return extractTicketNumber();
    }

    function extractTicketNumber(): string | null {
      const match = document.title.match(/T\d{8}\.\d{4}/);
      return match ? match[0] : null;
    }

    function extractTicketTitle(): string | null {
      // document.title típico: "T20250001.0001 - Nombre del ticket | Autotask PSA"
      const match = document.title.match(/T\d{8}\.\d{4}\s*[-–]\s*(.+?)(?:\s*\||\s*$)/);
      return match ? match[1].trim() : null;
    }

    function ticketLabel(): string {
      return extractTicketNumber() ?? (currentTicketId ? `#${currentTicketId}` : '');
    }

    // Identidad real usada para detectar colisiones: preferimos el número de ticket
    // (leído del título de la página, estable) sobre el ID interno de la URL. El ID de
    // la URL es frágil en vistas "workspace" con varios tickets abiertos a la vez: cada
    // técnico tiene su propia lista de tickets abiertos en su propio orden, así que
    // "ids[0]" puede no coincidir entre dos técnicos aunque estén viendo el mismo ticket
    // — eso hacía que nunca se detectara la colisión entre ellos. El ID crudo de la URL
    // se sigue mandando aparte (autotaskTicketId) porque el servidor sí lo necesita tal
    // cual para consultar el asignado en la API de Autotask.
    function presenceId(): string | null {
      if (currentTicketId === null) return null;
      return extractTicketNumber() ?? currentTicketId;
    }

    function formatNames(users: OtherUser[]): string {
      const names = users.map(u => u.name);
      if (names.length === 1) return names[0];
      return `${names.slice(0, -1).join(', ')} y ${names[names.length - 1]}`;
    }

    // Un solo AudioContext reutilizado para todos los sonidos. Antes se creaba uno
    // NUEVO en cada llamada a playSound() y nunca se cerraba (fuga), y además Chrome
    // bloquea que un AudioContext arranque sin que haya habido un gesto del usuario en
    // la página todavía ("AudioContext was not allowed to start" en consola).
    //
    // Ojo: ese warning lo dispara el simple `new AudioContext()`, no recién al intentar
    // programar un sonido — así que no alcanza con chequear ctx.state después de
    // crearlo, hay que evitar CREARLO hasta que conste que hubo un gesto real. Esto
    // importa en particular acá: el content script corre en TODO *.autotask.net, no
    // solo en tickets — incluida la pantalla de login (Authentication.mvc). Si llega
    // un aviso pendiente (ej. una asignación nueva) mientras el técnico recién está
    // por loguearse, sin haber tocado nada todavía, se intentaba sonar ahí mismo.
    let audioCtx: AudioContext | null = null;
    let hasUserGesture = false;
    function markUserGesture() {
      hasUserGesture = true;
      getAudioContext(); // crear/destrabar ya mismo, para no esperar al próximo sonido
    }
    document.addEventListener('pointerdown', markUserGesture, { once: true, passive: true });
    document.addEventListener('keydown', markUserGesture, { once: true });

    function getAudioContext(): AudioContext | null {
      if (!hasUserGesture) return null;
      if (!audioCtx) audioCtx = new AudioContext();
      if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
      return audioCtx;
    }

    function playSound(type: 'alert' | 'free' | 'ping' | 'new_entry') {
      const ctx = getAudioContext();
      // Sin gesto todavía, o el navegador lo sigue bloqueando pese al resume(): no hay
      // sonido, pero tampoco el error en consola — antes tampoco sonaba en este caso,
      // solo que además lo reportaba como fallo.
      if (!ctx || ctx.state !== 'running') return;
      const gain = ctx.createGain();
      gain.connect(ctx.destination);
      if (type === 'alert') {
        [0, 0.3].forEach((offset) => {
          const osc = ctx.createOscillator();
          osc.connect(gain);
          osc.frequency.value = 880;
          gain.gain.setValueAtTime(0.3, ctx.currentTime + offset);
          gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + offset + 0.25);
          osc.start(ctx.currentTime + offset);
          osc.stop(ctx.currentTime + offset + 0.25);
        });
      } else if (type === 'free') {
        const osc = ctx.createOscillator();
        osc.connect(gain);
        osc.frequency.setValueAtTime(440, ctx.currentTime);
        osc.frequency.linearRampToValueAtTime(880, ctx.currentTime + 0.3);
        gain.gain.setValueAtTime(0.3, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.4);
      } else if (type === 'ping') {
        [0, 0.12, 0.24].forEach((offset, i) => {
          const osc = ctx.createOscillator();
          osc.connect(gain);
          osc.frequency.value = 600 + i * 150;
          gain.gain.setValueAtTime(0.2, ctx.currentTime + offset);
          gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + offset + 0.1);
          osc.start(ctx.currentTime + offset);
          osc.stop(ctx.currentTime + offset + 0.1);
        });
      } else if (type === 'new_entry') {
        const osc = ctx.createOscillator();
        osc.connect(gain);
        osc.frequency.value = 660;
        gain.gain.setValueAtTime(0.15, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.2);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.2);
      }
    }

    // chrome.notifications NO existe en content scripts (solo en el background y en
    // páginas de extensión). Llamarlo acá tiraba "Cannot read properties of undefined
    // (reading 'create')". Delegamos al background, que sí tiene la API — y de paso
    // el chequeo de "no molestar" queda en un solo lugar.
    function sendChromeNotification(title: string, message: string) {
      safeChrome(() =>
        chrome.runtime
          .sendMessage({ type: 'NETSUS_NOTIFY', title, message })
          .catch((err) => { if (isContextError(err)) handleContextInvalidated(); }),
      );
    }

    // addNotif escribe en chrome.storage y devuelve una promesa: sin .catch(), un
    // contexto muerto la deja como "Uncaught (in promise)" en la consola.
    function saveNotif(n: Parameters<typeof addNotif>[0]) {
      safeChrome(() =>
        addNotif(n).catch((err) => { if (isContextError(err)) handleContextInvalidated(); }),
      );
    }

    // Toast en pantalla para notificaciones recién llegadas mientras el técnico
    // no está en el ticket que las originó (ej. viendo un tablero) — el diff
    // contra knownNotifIds evita repetir avisos ya vistos por esta pestaña.
    async function toastNewArrivals(list: AppNotification[]) {
      if (!knownNotifIds) return; // línea base todavía no cargada
      const fresh = list.filter((n) => !knownNotifIds!.has(n.id) && TOASTABLE_TYPES.has(n.type));
      for (const n of list) knownNotifIds.add(n.id);
      if (!fresh.length) return;
      // safeChrome() no sirve acá: chrome.storage.local.get(cb) siempre "devuelve"
      // undefined (API de callback), así que su valor de retorno no puede usarse
      // para decidir si ya resolvimos la promesa — se replica el mismo guard a mano.
      const dnd = await new Promise<boolean>((resolve) => {
        if (!extensionAlive()) { resolve(false); return; }
        try {
          chrome.storage.local.get(['netsus_dnd_until'], (data: any) => {
            resolve(typeof data.netsus_dnd_until === 'number' && data.netsus_dnd_until > Date.now());
          });
        } catch (err) {
          if (isContextError(err)) handleContextInvalidated();
          resolve(false);
        }
      });
      if (dnd) return;
      for (const n of fresh) {
        if (isMuted(typePrefs, n.type)) continue;
        showNotifToast(n);
        playSoundForSeverity(n.severity);
      }
    }

    const SEVERITY_SOUND: Record<Severity, 'alert' | 'free' | 'ping' | 'new_entry'> = {
      critical: 'alert',
      warning: 'ping',
      info: 'new_entry',
      success: 'free',
    };

    function playSoundForSeverity(sev: Severity) {
      if (soundEnabled) playSound(SEVERITY_SOUND[sev]);
    }

    // Re-nag: si una notificación con re-insistencia sigue sin leerse tras X min,
    // vuelve a avisar (sonido + pop-up del sistema). Config: netsus_renag_min.
    function startRenagLoop() {
      clearInterval(renagTimer);
      renagTimer = window.setInterval(async () => {
        if (!extensionAlive()) { handleContextInvalidated(); return; }
        try {
          const [list, renagMin] = await Promise.all([getNotifs(), getRenagMinutes()]);
          const due = dueForRenag(list, renagMin);
          for (const n of due) {
            if (isMuted(typePrefs, n.type)) continue;
            playSoundForSeverity(n.severity);
            sendChromeNotification(`🔔 ${n.title}`, n.body); // pop-up del SO: sin soporte SVG, mantiene emoji
            await bumpNag(n.id);
          }
        } catch (err) {
          // Sin este catch, el await de una promesa de chrome.storage que falla por
          // contexto muerto se reporta como "Uncaught (in promise)".
          if (isContextError(err)) handleContextInvalidated();
        }
      }, 30000);
    }

    // Bloquea la interacción con el ticket durante una colisión. El side panel
    // vive fuera del DOM de la página (no hace falta excluirlo), pero el banner
    // in-page (lib/banner.ts) sí es parte del body y necesita quedar afuera del
    // bloqueo para que sus propios botones (Avisar/Pausar/Terminé) sigan
    // funcionando durante la colisión que ellos mismos ayudan a resolver.
    //
    // El editor de Autotask (descripción, resolución, adjuntos...) vive en un
    // <iframe> same-origin dentro de TicketDetail.mvc, no en el documento top. El
    // content script solo se inyecta ahí (allFrames no está declarado → default
    // false), así que este bloqueo tenía que alcanzar cada iframe explícitamente:
    // antes solo tocaba `document`, y como resultado el aviso y el sonido andaban
    // pero se seguía pudiendo editar/guardar el ticket durante una colisión.
    const LOCK_STYLE_ID = 'netsus-lock-style';
    const LOCK_CSS = `
      body.netsus-locked button:not(#netsus-banner *):not(#netsus-assign-pill *),
      body.netsus-locked textarea:not(#netsus-banner *):not(#netsus-assign-pill *),
      body.netsus-locked input:not([type="search"]):not([type="text"][readonly]):not(#netsus-banner *):not(#netsus-assign-pill *) {
        pointer-events: none !important; opacity: 0.45 !important; cursor: not-allowed !important;
      }
    `;

    // Recorre `document` y, recursivamente, todo iframe alcanzable desde ahí. Un
    // iframe de otro origen tira al leer `.contentDocument` (same-origin policy
    // del navegador, no de la extensión) — nada que hacer ahí, se salta en silencio.
    function forEachAutotaskDocument(fn: (doc: Document) => void) {
      const walk = (doc: Document) => {
        fn(doc);
        let frames: HTMLCollectionOf<HTMLIFrameElement>;
        try {
          frames = doc.getElementsByTagName('iframe');
        } catch {
          return;
        }
        for (const frame of Array.from(frames)) {
          let inner: Document | null = null;
          try {
            inner = frame.contentDocument;
          } catch {
            // cross-origin — fuera de alcance, no es un error nuestro.
          }
          if (inner) walk(inner);
        }
      };
      walk(document);
    }

    function lockUI() {
      forEachAutotaskDocument((doc) => {
        if (!doc.head || !doc.body) return;
        if (!doc.getElementById(LOCK_STYLE_ID)) {
          const style = doc.createElement('style');
          style.id = LOCK_STYLE_ID;
          style.textContent = LOCK_CSS;
          doc.head.appendChild(style);
        }
        doc.body.classList.add('netsus-locked');
      });
    }

    function unlockUI() {
      forEachAutotaskDocument((doc) => {
        doc.body?.classList.remove('netsus-locked');
        doc.getElementById(LOCK_STYLE_ID)?.remove();
      });
    }

    function startAutoPing(others: OtherUser[]) {
      clearTimeout(autoPingTimer);
      if (autoPingFired || !others.length) return;
      autoPingTimer = window.setTimeout(() => {
        if (!currentTicketId || !currentUser || !others.length) return;
        autoPingFired = true;
        apiCall('POST', `/api/presence/${presenceId()}`, {
          user: currentUser,
          ping: others.map(o => o.name),
        }, () => {});
        sendChromeNotification('📣 Auto-aviso enviado', `Se notificó a ${formatNames(others)} después de ${AUTO_PING_MINUTES} min de espera`);
      }, AUTO_PING_MINUTES * 60 * 1000);
    }

    function showCollision(others: OtherUser[]) {
      const prevNames = new Set(lastOthers.map(o => o.name));
      const hasNewEntry = others.some(o => !prevNames.has(o.name));
      lastOthers = others;

      setState({ kind: 'collision', others, ticketLabel: ticketLabel(), ticketTitle: extractTicketTitle() ?? undefined });

      if (!wasLocked) {
        const colMuted = isMuted(typePrefs, 'collision');
        if (soundEnabled && !colMuted) playSound('alert');
        const verb = others.length === 1 ? 'está' : 'están';
        if (!colMuted) sendChromeNotification('Ticket ocupado', `${formatNames(others)} ${verb} trabajando en este ticket`);
        const label = extractTicketNumber();
        saveNotif({
          type: 'collision',
          title: 'Colisión detectada',
          body: `${formatNames(others)} ${verb} trabajando en ${label ?? 'este ticket'}`,
          ticketId: currentTicketId ?? undefined,
          ticketNumber: label ?? undefined,
          ticketUrl: window.location.href,
          silent: true, // el panel lateral ya avisó; solo registrar en el buzón
        });
        lockUI();
        startAutoPing(others);
      } else if (hasNewEntry && soundEnabled) {
        playSound('new_entry');
      }
      wasLocked = true;
    }

    function showLiberation() {
      clearTimeout(autoPingTimer);
      autoPingFired = false;
      unlockUI();
      const label = ticketLabel();
      const title = extractTicketTitle() ?? undefined;
      setState({ kind: 'liberated', ticketLabel: label, ticketTitle: title });
      const libMuted = isMuted(typePrefs, 'liberation');
      if (soundEnabled && !libMuted) playSound('free');
      if (!libMuted) sendChromeNotification('Ticket liberado', 'Ya puedes trabajar en este ticket');
      const num = extractTicketNumber();
      saveNotif({
        type: 'liberation',
        title: 'Ticket liberado',
        body: `Ya puedes trabajar en ${num ?? 'este ticket'}`,
        ticketId: currentTicketId ?? undefined,
        ticketNumber: num ?? undefined,
        ticketUrl: window.location.href,
        silent: true,
      });
      setTimeout(() => {
        if (currentTicketId) setState({ kind: 'solo', ticketLabel: label, ticketTitle: title });
      }, 4000);
    }

    function resumeAfterPause() {
      clearInterval(pauseTickInterval);
      currentTicketId = null; // fuerza a init() a re-registrar presencia aunque sea el mismo ticket
      init();
    }

    function pausePresence(minutes: number) {
      if (!currentTicketId || !currentUser) return;
      if (lastPresenceId) leavePresence(lastPresenceId, currentUser);
      clearInterval(pollInterval);
      wasLocked = false;
      unlockUI();

      let secsLeft = minutes * 60;
      setState({ kind: 'paused', secsLeft });
      pauseTickInterval = window.setInterval(() => {
        secsLeft--;
        if (secsLeft <= 0) { clearInterval(pauseTickInterval); return; }
        setState({ kind: 'paused', secsLeft });
      }, 1000);
      pauseTimeout = window.setTimeout(resumeAfterPause, minutes * 60 * 1000);
    }

    function triggerFinish() {
      if (currentTicketId && currentUser) {
        // "Terminé" solo aparece en el banner/panel DURANTE una colisión (ver
        // lib/banner.ts y sidepanel/main.ts) — es el botón de "dar paso al
        // compañero". Se captura acá, antes de resetear wasLocked más abajo, para
        // no cerrar la pestaña si esta función se llamara alguna vez fuera de ese
        // contexto.
        const wasCollision = wasLocked;
        if (lastPresenceId) leavePresence(lastPresenceId, currentUser);
        clearInterval(pollInterval);
        clearTimeout(autoPingTimer);
        wasLocked = false;
        unlockUI();
        currentTicketId = null;
        lastPresenceId = null;
        setState({ kind: 'idle' });

        // A pedido explícito: sin esto, el técnico que declaró "Terminé" podía
        // quedarse en la misma pestaña y seguir editando — recreando la colisión
        // que el clic acababa de resolver. Con un pequeño margen para que se
        // alcance a ver el aviso, en vez de que la pestaña desaparezca de golpe.
        if (wasCollision) {
          sendChromeNotification('Ticket liberado', 'Cerrando esta pestaña…');
          setTimeout(() => {
            safeChrome(() => browser.runtime.sendMessage({ type: 'NSB_CLOSE_TAB' }));
          }, 1200);
        }
      }
    }

    function triggerPing(quickMsg?: string) {
      if (pingCooldown || !currentTicketId || !currentUser) return;
      pingCooldown = true;
      const body: Record<string, unknown> = {
        user: currentUser,
        ping: lastOthers.map(u => u.name),
      };
      if (quickMsg) body.quickMsg = quickMsg;
      apiCall('POST', `/api/presence/${presenceId()}`, body, () => {});
      setTimeout(() => { pingCooldown = false; }, 15000);
    }

    let consecutiveFailures = 0;

    function apiCall(
      method: string,
      path: string,
      body: Record<string, unknown> | null,
      callback?: (status: number, data: any) => void
    ) {
      safeChrome(() =>
        browser.runtime
          .sendMessage({ type: 'NETSUS_API', method, path, body })
          .then((res: any) => {
            if (!res?.sent) {
              consecutiveFailures++;
              if (consecutiveFailures >= 3) setOffline(true);
              return;
            }
            consecutiveFailures = 0;
            setOffline(false);
            callback?.(res.status, res.data);
          })
          .catch((err) => {
            if (isContextError(err)) { handleContextInvalidated(); return; }
            consecutiveFailures++;
            if (consecutiveFailures >= 3) setOffline(true);
          }),
      );
    }

    function registerPresence(ticketId: string, user: string, pingTargets?: string[]) {
      lastPresenceId = ticketId;
      const body: Record<string, unknown> = {
        user,
        ticketNumber: extractTicketNumber(),
        ticketTitle: extractTicketTitle() ?? undefined,
        ticketUrl: window.location.href,
        autotaskTicketId: currentTicketId,
      };
      if (pingTargets?.length) body.ping = pingTargets;

      apiCall('POST', `/api/presence/${ticketId}`, body, (_status, data) => {
        // apiCall es asíncrono (viaja por chrome.runtime.sendMessage hasta el
        // background y vuelve) — si el técnico hace clic en "Terminé" MIENTRAS esta
        // respuesta viaja, triggerFinish() ya limpió currentTicketId/lastPresenceId
        // antes de que llegue, pero el callback seguía ejecutándose igual: si esa
        // respuesta tardía traía `others`, sonaba la alerta de colisión DESPUÉS de
        // haber liberado el ticket. Este guard descarta cualquier respuesta que ya
        // no corresponda al ticket que seguimos mirando ahora mismo.
        if (stopped || currentTicketId === null || ticketId !== lastPresenceId) return;
        if (data?.completed === true) {
          setState({ kind: 'completed', ticketLabel: ticketLabel() });
          // El ticket está en solo lectura — no tiene sentido la advertencia de
          // "asignado a X" (mismatch), pero el recurso principal sigue siendo
          // información de contexto útil, así que se muestra igual.
          setAssignment(null, data?.assignedTo ?? null, data?.statusLabel ?? null, false);
          clearInterval(pollInterval);
          pollInterval = undefined;
          return;
        }

        const others: OtherUser[] = Array.isArray(data?.others)
          ? data.others
              .map((o: any) => typeof o === 'string' ? { name: o, minutes: 0 } : o)
              .filter((o: OtherUser) => o.name.trim().toLowerCase() !== user.trim().toLowerCase())
          : [];

        if (others.length > 0) {
          showCollision(others);
        } else {
          if (wasLocked) showLiberation();
          else setState({ kind: 'solo', ticketLabel: ticketLabel(), ticketTitle: extractTicketTitle() ?? undefined });
          wasLocked = false;
          if (data?.pastCollisions >= 2) setHistoryWarning(data.pastCollisions);
        }

        const mismatchedAssignee = data?.assignedTo && data.assignedTo.trim().toLowerCase() !== user.trim().toLowerCase();
        setAssignment(mismatchedAssignee ? data.assignedTo : null, data?.assignedTo ?? null, data?.statusLabel ?? null, Boolean(data?.assignedPresent));

        if (data?.pingedBy) {
          const pingMuted = isMuted(typePrefs, 'ping');
          if (soundEnabled && !pingMuted) playSound('ping');
          const pingLabel = extractTicketNumber();
          const pingMsg = data.quickMsg
            ? `"${data.quickMsg}"`
            : `Quiere saber si terminaste en ${pingLabel ?? 'este ticket'}`;
          if (!pingMuted) sendChromeNotification('📣 ' + data.pingedBy + ' te avisa', pingMsg);
          saveNotif({
            type: 'ping',
            title: `${data.pingedBy} te está esperando`,
            body: `Quiere saber si terminaste en ${pingLabel ?? 'este ticket'}`,
            ticketId: ticketId,
            ticketNumber: pingLabel ?? undefined,
            ticketUrl: window.location.href,
            dedupeKey: `ping:${ticketId}:${data.pingedBy}`,
            silent: true,
          });
        }
      });
    }

    function leavePresence(ticketId: string, user: string) {
      apiCall('DELETE', `/api/presence/${ticketId}`, { user });
    }

    function init() {
      if (!currentUser) return;
      const ticketId = extractTicketId();
      if (ticketId === currentTicketId) return;

      if (currentTicketId) {
        if (lastPresenceId) leavePresence(lastPresenceId, currentUser);
        clearInterval(pollInterval);
        clearTimeout(autoPingTimer);
        autoPingFired = false;
        wasLocked = false;
        unlockUI();
      }

      currentTicketId = ticketId;
      lastPresenceId = null;
      bannerMinimized = false;
      bannerDismissed = false;
      removeBanner();
      removeInsightWidget();
      setHistoryWarning(null);
      setAssignment(null, null);

      if (!ticketId) {
        setState({ kind: 'idle' });
        return;
      }

      setState({ kind: 'solo', ticketLabel: ticketLabel(), ticketTitle: extractTicketTitle() ?? undefined });
      const pid = presenceId();
      if (pid) registerPresence(pid, currentUser);
      pollInterval = window.setInterval(() => {
        if (stopped || !currentUser) return;
        const p = presenceId();
        if (p) registerPresence(p, currentUser);
        // Sincronización periódica con el sidepanel: si el panel perdió el NSB_STATE
        // inicial (race condition de startup), este push lo recupera en ≤5 s.
        pushState();
      }, 5000);
    }

    // El side panel pide el estado actual al abrirse o cambiar de pestaña, y
    // envía acciones (avisar, terminé, pausar, cancelar pausa) que antes eran
    // botones dentro del panel inyectado en la página.
    safeChrome(() => chrome.runtime.onMessage.addListener((msg: PanelToContentMessage, _sender, sendResponse) => {
      if (stopped) return false;
      if (msg?.type === 'NSB_REQUEST_STATE') {
        sendResponse({ payload: { state: currentState, warnings: currentWarnings } });
        return false;
      }
      if (msg?.type === 'NSB_ACTION') {
        if (msg.action === 'ping') triggerPing((msg as any).quickMsg);
        else if (msg.action === 'finish') triggerFinish();
        else if (msg.action === 'pause') pausePresence(msg.minutes);
        else if (msg.action === 'cancelPause') { clearTimeout(pauseTimeout); resumeAfterPause(); }
      }
      return false;
    }));

    window.addEventListener('beforeunload', () => {
      if (stopped) return;
      if (lastPresenceId && currentUser) leavePresence(lastPresenceId, currentUser);
    });

    let lastUrl = location.href;
    urlObserver = new MutationObserver(() => {
      if (stopped) return;
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        setTimeout(loadUserAndInit, 500);
      }
      // Si Autotask carga el iframe del editor DESPUÉS de que ya estábamos
      // bloqueados (ej. el técnico hace clic en "Editar" en medio de la colisión),
      // ese iframe nace sin el bloqueo — lockUI() ya se había ejecutado antes de
      // que existiera. Re-aplicar es barato: lockUI() no reinyecta el <style> si ya
      // está, solo confirma la clase en cada documento alcanzable.
      if (wasLocked) lockUI();
    });
    urlObserver.observe(document.body, { childList: true, subtree: true });

    openLifeline();
    watchAutoPingConfig();

    safeChrome(() => getTypePrefs().then((p) => { typePrefs = p; }).catch(() => {}));
    safeChrome(() => subscribePrefs(({ typePrefs: tp }) => { if (tp) typePrefs = tp; }));

    // Alimenta la tarjeta embebida (lib/insight-widget.ts) sin polling propio —
    // reusa el mismo buzón que ya escribe saveNotif() más arriba.
    safeChrome(() => getNotifs().then((list) => {
      recentNotifs = list;
      knownNotifIds = new Set(list.map((n) => n.id)); // línea base — no toastear el historial
      pushState();
    }).catch(() => {}));
    safeChrome(() => subscribeNotifs((list) => {
      if (stopped) return; // ver nota en SUPERSEDE_EVENT: no repintar una instancia ya apagada
      recentNotifs = list;
      void toastNewArrivals(list);
      pushState();
    }));

    // Heartbeat: marca esta pestaña como "viva" para que el background solo haga el
    // re-nag de respaldo (OS) cuando no hay ninguna pestaña de Autotask abierta.
    // Además sirve de detector: es lo primero que falla al recargarse la extensión,
    // así que apaga el resto de los timers antes de que floodeen la consola.
    const beat = () => safeChrome(() => chrome.storage.local.set({ netsus_cs_heartbeat: Date.now() }));
    beat();
    heartbeatInterval = window.setInterval(beat, 15000);

    startRenagLoop();

    setTimeout(loadUserAndInit, 1000);
  },
});
