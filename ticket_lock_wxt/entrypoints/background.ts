import {
  add as addNotif,
  getAll as getNotifs,
  dueForRenag,
  getRenagMinutes,
  bumpNag,
  type NotifType,
} from '@/lib/notifications';
import { getTypePrefs, isMuted } from '@/lib/prefs';

const DEFAULT_BASE_URL = 'https://netsus-two.vercel.app';
const DEFAULT_API_KEY = '-_-ErJy9v64XRiDbpuPFZ3uLs4nVFmXm';
// Ver comentario en el registro de la alarma de "asignaciones" más abajo: es la
// única llamada de este archivo que pega a Autotask sin caché y escala 1:1 con
// la cantidad de técnicos — el punto más barato para bajar cuota de API. Con
// n2_assign (src/lib/notif-poll.ts) ya cubriendo el mismo evento por un canal
// compartido/barato, esta corrida es más que nada respaldo — 10 min es holgado.
const ASSIGN_CHECK_INTERVAL_MS = 10 * 60 * 1000;

let apiOnline = true;

interface FeedItem {
  type: NotifType;
  title: string;
  body: string;
  ticketId?: string;
  ticketNumber?: string;
  ticketUrl?: string;
  dedupeKey?: string;
}

// chrome.storage.local.get() normalmente siempre entrega un objeto (vacío si no hay
// nada guardado), pero en una carrera con el service worker reiniciándose (MV3 lo
// suspende tras ~30s de inactividad y lo despierta bajo demanda) puede resolver con
// `undefined` en vez de `{}` — eso es lo que producía "Cannot destructure property
// '...' of 'undefined'" en getConfig() más abajo. Este wrapper normaliza ese caso y de
// paso lee chrome.runtime.lastError explícitamente: si no se toca, Chrome reporta un
// "Unchecked runtime.lastError" aparte por cada llamada donde hubo error.
function storageGet<T extends Record<string, unknown>>(keys: string[]): Promise<Partial<T>> {
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, (data) => {
      void chrome.runtime.lastError;
      resolve((data ?? {}) as Partial<T>);
    });
  });
}

function getStoredUser(): Promise<string | null> {
  return storageGet<{ netsus_user: string }>(['netsus_user']).then(({ netsus_user }) => netsus_user || null);
}

async function isDnd(): Promise<boolean> {
  const { netsus_dnd_until } = await storageGet<{ netsus_dnd_until: number }>(['netsus_dnd_until']);
  return typeof netsus_dnd_until === 'number' && netsus_dnd_until > Date.now();
}

async function pollNotificationFeed() {
  const name = await getStoredUser();
  if (!name) return;
  const { baseUrl: BASE_URL, apiKey: API_KEY } = await getConfig();
  try {
    const res = await fetchWithRetry(
      `${BASE_URL}/api/notifications?user=${encodeURIComponent(name)}`,
      { headers: { 'x-api-key': API_KEY } },
      1,
    );
    if (!res.ok) return;
    const data = await res.json().catch(() => null);
    const items: FeedItem[] = Array.isArray(data?.items) ? data.items : [];
    if (!items.length) return;
    const [prefs, dnd] = await Promise.all([getTypePrefs(), isDnd()]);
    for (const it of items) {
      await addNotif({
        type: it.type,
        title: it.title,
        body: it.body,
        ticketId: it.ticketId,
        ticketNumber: it.ticketNumber,
        ticketUrl: it.ticketUrl,
        dedupeKey: it.dedupeKey,
        silent: true,
      });
      if (dnd) continue;
      if (isMuted(prefs, it.type)) continue;
      chrome.notifications.create({
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icon/128.png'),
        title: it.title,
        message: it.body,
        priority: 2,
      });
    }
  } catch {
    // silencioso: el próximo ciclo reintenta
  }
}

function getHeartbeat(): Promise<number | undefined> {
  return storageGet<{ netsus_cs_heartbeat: number }>(['netsus_cs_heartbeat']).then(({ netsus_cs_heartbeat }) => netsus_cs_heartbeat);
}

async function backgroundRenag() {
  const beat = await getHeartbeat();
  if (beat && Date.now() - beat < 45000) return;
  const [list, renagMin, prefs, dnd] = await Promise.all([getNotifs(), getRenagMinutes(), getTypePrefs(), isDnd()]);
  if (dnd) return;
  for (const n of dueForRenag(list, renagMin)) {
    if (isMuted(prefs, n.type)) continue;
    chrome.notifications.create({
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icon/128.png'),
      title: `🔔 ${n.title}`,
      message: n.body,
      priority: 2,
    });
    await bumpNag(n.id);
  }
}

async function getConfig(): Promise<{ baseUrl: string; apiKey: string }> {
  const { netsus_base_url, netsus_api_key } = await storageGet<{ netsus_base_url: string; netsus_api_key: string }>(
    ['netsus_base_url', 'netsus_api_key'],
  );
  return {
    baseUrl: netsus_base_url || DEFAULT_BASE_URL,
    apiKey: netsus_api_key || DEFAULT_API_KEY,
  };
}

async function fetchWithRetry(url: string, options: RequestInit, maxAttempts = 3): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const res = await fetch(url, options);
      return res;
    } catch (err) {
      lastError = err;
      if (attempt < maxAttempts - 1) {
        await new Promise(r => setTimeout(r, 500 * Math.pow(2, attempt)));
      }
    }
  }
  throw lastError;
}

async function updateBadge() {
  const { baseUrl: BASE_URL, apiKey: API_KEY } = await getConfig();
  try {
    const res = await fetchWithRetry(`${BASE_URL}/api/presence/status`, {
      headers: { 'x-api-key': API_KEY },
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const tickets: any[] = await res.json().catch(() => []);
    const collisions = Array.isArray(tickets)
      ? tickets.filter((t) => t.users.length > 1).length
      : 0;
    apiOnline = true;
    if (collisions > 0) {
      chrome.action.setBadgeText({ text: String(collisions) });
      chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
    } else {
      chrome.action.setBadgeText({ text: '' });
    }
  } catch {
    if (apiOnline) {
      apiOnline = false;
      chrome.action.setBadgeText({ text: '!' });
      chrome.action.setBadgeBackgroundColor({ color: '#6b7280' });
    }
  }
}

// --- Notificaciones de asignación de tickets ---
// Los IDs vistos se persisten en chrome.storage.local para sobrevivir reinicios del
// service worker (MV3 mata el SW tras ~30s de inactividad; la alarma netsus-keepalive
// lo reactiva, pero el estado en memoria se pierde).
const ticketUrls = new Map<number, string>();

async function checkNewAssignments() {
  const name = await getStoredUser();
  if (!name) return;
  const { baseUrl: BASE_URL, apiKey: API_KEY } = await getConfig();

  const assignData = await storageGet<{ netsus_seen_tickets: number[]; netsus_assign_ready: boolean; netsus_assign_last: number }>(
    ['netsus_seen_tickets', 'netsus_assign_ready', 'netsus_assign_last'],
  );
  const stored = {
    ids: Array.isArray(assignData.netsus_seen_tickets) ? assignData.netsus_seen_tickets : [],
    ready: !!assignData.netsus_assign_ready,
    last: assignData.netsus_assign_last || 0,
  };

  const seenIds = new Set<number>(stored.ids);
  const sinceParam = stored.ready
    ? `&since=${new Date(stored.last - 10000).toISOString()}`
    : '';
  const now = Date.now();

  try {
    const res = await fetch(
      `${BASE_URL}/api/presence/my-tickets?user=${encodeURIComponent(name)}${sinceParam}`,
      { headers: { 'x-api-key': API_KEY } },
    );
    if (!res.ok) return;
    const { tickets } = await res.json().catch(() => ({ tickets: [] }));
    if (!Array.isArray(tickets)) return;

    const dnd = await isDnd();

    for (const t of tickets) {
      if (t.url) ticketUrls.set(t.id, t.url);

      if (!stored.ready) {
        seenIds.add(t.id); // primera carga: registrar sin notificar
      } else if (!seenIds.has(t.id)) {
        seenIds.add(t.id);
        if (!dnd) {
          const label = t.ticketNumber ?? `#${t.id}`;
          const msg = t.title ? `${label} — ${t.title}` : label;
          chrome.notifications.create(`netsus-assign-${t.id}`, {
            type: 'basic',
            iconUrl: chrome.runtime.getURL('icon/128.png'),
            title: 'Ticket asignado',
            message: `Se te asignó el ticket ${msg}`,
            priority: 2,
          });
        }
      }
    }

    await chrome.storage.local.set({
      netsus_seen_tickets: [...seenIds].slice(-300),
      netsus_assign_ready: true,
      netsus_assign_last: now,
    });
  } catch {
    // silencioso
  }
}

function registerAssignmentClickHandler() {
  chrome.notifications.onClicked.addListener((id) => {
    if (!id.startsWith('netsus-assign-')) return;
    const ticketId = parseInt(id.replace('netsus-assign-', ''), 10);
    const url = ticketUrls.get(ticketId);
    if (url) chrome.tabs.create({ url });
    chrome.notifications.clear(id);
  });
}

// Cualquier excepción síncrona dentro de main() hace que WXT la re-lance, y Chrome
// aborta el registro del service worker con "Service worker registration failed.
// Status code: 15". Como sin service worker la extensión entera queda inutilizable
// (los content scripts pierden su puente), aislamos cada paso del arranque: si uno
// falla, se pierde solo esa funcionalidad y el resto sigue en pie.
function step(name: string, fn: () => void) {
  try {
    fn();
  } catch (err) {
    console.error(`[CoView] Falló el arranque de "${name}":`, err);
  }
}

export default defineBackground(() => {
  step('sidePanel', () => {
    chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  });

  // Al instalar o actualizar la extensión, re-inyectar el content script en todas las
  // pestañas de Autotask que ya estaban abiertas. Sin esto, el usuario tendría que hacer
  // F5 manualmente en cada pestaña después de recargar la extensión.
  step('reinyección de content scripts', () => {
    chrome.runtime.onInstalled.addListener(async () => {
      const tabs = await chrome.tabs.query({ url: 'https://*.autotask.net/*' });
      for (const tab of tabs) {
        if (!tab.id) continue;
        chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['content-scripts/content.js'],
        }).catch(() => {});

        // El puente del main world va aparte, con su propio `world`: reinyectar solo
        // content.js dejaba al consumidor vivo pero sin nadie que volviera a publicar
        // la identidad. Pasaba desapercibido porque el data-attribute de la ejecución
        // previa seguía en el DOM — pero si el puente nunca había llegado a publicar,
        // el técnico quedaba sin detección hasta refrescar la pestaña a mano.
        //
        // Va DESPUÉS y en su propio try: en Firefox (MV2) este archivo no se emite y
        // `world` no existe, y un throw síncrono acá abortaría el resto del bucle —
        // dejando pestañas sin reinyectar, que es peor que no tener puente.
        if (import.meta.env.BROWSER !== 'firefox') {
          try {
            chrome.scripting.executeScript({
              target: { tabId: tab.id },
              files: ['content-scripts/walkme-bridge.js'],
              world: 'MAIN',
            }).catch(() => {});
          } catch { /* API sin soporte de `world` — el puente declarado en el manifest sigue corriendo en cargas normales. */ }
        }
      }
    });
  });

  // Keep-alive: los service workers MV3 se duermen tras ~30s de inactividad,
  // interrumpiendo el polling de asignaciones y de notificaciones.
  // Mínimo 0.5 min (30s) para respetar el límite de Chrome en modo desarrollador.
  // Requiere el permiso 'alarms' en wxt.config.ts.
  step('keep-alive', () => {
    chrome.alarms.create('netsus-keepalive', { periodInMinutes: 0.5 });
    chrome.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name === 'netsus-keepalive') updateBadge();
    });
  });

  // Los content scripts abren un puerto contra nosotros para detectar al instante
  // cuándo desaparece la extensión (ver openLifeline en content.ts). No hay que
  // hacer nada con él: alcanza con aceptarlo para que quede abierto, porque un
  // puerto sin nadie del otro lado se desconecta enseguida.
  step('lifeline', () => {
    chrome.runtime.onConnect.addListener(() => {});
  });

  step('badge', () => {
    setInterval(updateBadge, 20000);
    updateBadge();
  });

  step('feed de notificaciones', () => {
    setInterval(pollNotificationFeed, 30000);
    pollNotificationFeed();
  });

  step('re-nag', () => {
    setInterval(backgroundRenag, 30000);
  });

  step('asignaciones', () => {
    registerAssignmentClickHandler();
    checkNewAssignments();
    // Cada corrida es 1 llamada real a Autotask (Tickets/query) sin caché, por
    // técnico — a diferencia del resto del polling, que está cacheado o
    // compartido entre todo el equipo. A 60s eran 60 llamadas/hora por técnico;
    // a 10 min quedan en 6/hora. La asignación nueva igual se avisa casi al
    // instante por n2_assign (canal compartido, ver notif-poll.ts) — esta
    // corrida es más un respaldo que la vía principal, así que el margen es holgado.
    setInterval(checkNewAssignments, ASSIGN_CHECK_INTERVAL_MS);
  });

  browser.runtime.onMessage.addListener((message: any, _sender, sendResponse) => {
    if (message?.type === 'NETSUS_STATUS') {
      sendResponse({ online: apiOnline });
      return false;
    }

    // El content script no puede cerrar su propia pestaña: window.close() solo
    // funciona en pestañas que un script abrió con window.open(), no en una que el
    // técnico abrió a mano — así que nos pide a nosotros, que sí tenemos permiso
    // 'tabs'. Se dispara desde triggerFinish() al declarar "Terminé" durante una
    // colisión, para que no se quede editando en la misma pestaña que acaba de
    // liberar.
    if (message?.type === 'NSB_CLOSE_TAB') {
      if (_sender.tab?.id) chrome.tabs.remove(_sender.tab.id).catch(() => {});
      return false;
    }

    // Los content scripts no tienen acceso a chrome.notifications, así que nos
    // piden a nosotros que creemos el pop-up del sistema.
    if (message?.type === 'NETSUS_NOTIFY') {
      isDnd().then((dnd) => {
        if (dnd) return;
        chrome.notifications.create({
          type: 'basic',
          iconUrl: chrome.runtime.getURL('icon/128.png'),
          title: message.title,
          message: message.message,
          priority: 2,
        });
      });
      return false;
    }

    if (message?.type !== 'NETSUS_API') return false;

    const shouldRetry = message.method !== 'GET' && !message.path?.includes('/api/presence/') || message.method === 'DELETE';
    const maxAttempts = shouldRetry ? 3 : 1;

    getConfig().then(({ baseUrl: BASE_URL, apiKey: API_KEY }) =>
      fetchWithRetry(`${BASE_URL}${message.path}`, {
        method: message.method,
        headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
        body: message.body ? JSON.stringify(message.body) : null,
      }, maxAttempts)
      .then(async (r) => {
        const data = await r.json().catch(() => null);
        sendResponse({ sent: true, status: r.status, data });
        if (message.path?.startsWith('/api/presence/')) {
          setTimeout(updateBadge, 800);
        }
      })
      .catch((err) => {
        sendResponse({ sent: false, error: String(err) });
      })
    );

    return true;
  });
});
