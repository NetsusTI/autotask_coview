import { NextRequest, NextResponse } from 'next/server';
import { checkApiKey, redis, ACTIVE_TICKETS_KEY } from '@/lib/ticket-lock';
import { logCentralNotification } from '@/lib/notif-poll';
import { supabase } from '@/lib/supabase/client';
import { lookupResourceId } from '@/lib/supabase/resources';
import { dedupeOthers, minutesSince, formatDuration } from '@/lib/collision';
import { clampInt } from '@/lib/num';
import { createTicketNote, getTicketAssignedResourceId, getResourceName, getTicketStatus, getTicketStatusLabel, AUTOTASK_STATUS_COMPLETE } from '@/lib/autotask';
import { isValidTicketId, sanitizeUser } from '@/lib/sanitize';
import { logError } from '@/lib/error-log';

const PRESENCE_TTL = 40;

// Cache en memoria del proceso para los config:* que este endpoint lee en CADA
// POST de presencia (el más llamado de todo el backend, cada 20s por pestaña de
// ticket abierta). Casi nunca cambian, así que vale la pena tolerar hasta 60s de
// desfase a cambio de ahorrar varios comandos Redis por invocación — se pierde al
// reciclarse la instancia de la función (normal en serverless), no hay nada que
// limpiar manualmente.
const configCache = new Map<string, { value: string | null; expires: number }>();
async function getCachedConfig(key: string, ttlMs = 60_000): Promise<string | null> {
  const cached = configCache.get(key);
  if (cached && cached.expires > Date.now()) return cached.value;
  const value = await redis.get<string>(key);
  configCache.set(key, { value, expires: Date.now() + ttlMs });
  return value;
}

function presenceKey(ticketId: string, user: string) {
  return `ticketpresence:${ticketId}:${user}`;
}

function extractUser(key: string, ticketId: string) {
  return key.replace(`ticketpresence:${ticketId}:`, '');
}

async function getAutotaskAssignee(ticketId: string): Promise<string | null> {
  const cacheKey = `ticketassigned:${ticketId}`;
  const cached = await redis.get<string>(cacheKey);
  if (cached !== null) return cached === '' ? null : cached;

  const resourceId = await getTicketAssignedResourceId(ticketId);
  if (!resourceId) { await redis.set(cacheKey, '', { ex: 300 }); return null; }

  const name = await getResourceName(resourceId);
  await redis.set(cacheKey, name ?? '', { ex: 300 });
  return name;
}

// Nota automática en Autotask — apagada por defecto (config:autotask_notes_enabled),
// ver comentario en src/lib/autotask.ts sobre por qué. Fire-and-forget: createTicketNote
// nunca lanza, así que un fallo de Autotask no puede romper la respuesta de colisión.
async function maybeCreateAutotaskNote(numericTicketId: string | null, title: string, description: string) {
  if (!numericTicketId) return;
  const enabled = await getCachedConfig('config:autotask_notes_enabled');
  if (enabled !== '1') return;
  createTicketNote(Number(numericTicketId), { title, description });
}

async function getWebhookUrl(): Promise<string | null> {
  return getCachedConfig('config:teams_webhook');
}

async function isWithinWorkHours(): Promise<boolean> {
  const raw = await getCachedConfig('config:work_hours');
  if (!raw) return true;
  try {
    const { start = 8, end = 18, tz = 'America/Santiago' } = JSON.parse(raw);
    const now = new Date();
    const hour = parseInt(new Intl.DateTimeFormat('en', { hour: 'numeric', hour12: false, timeZone: tz }).format(now));
    const dayName = new Intl.DateTimeFormat('en', { weekday: 'short', timeZone: tz }).format(now);
    const isWeekend = dayName === 'Sat' || dayName === 'Sun';
    return !isWeekend && hour >= start && hour < end;
  } catch { return true; }
}

// Traza no-bloqueante de un nombre que no matchea el roster sincronizado — ver
// comentario junto al call site. Fire-and-forget (no se hace `await` sobre esto
// en el caller): un problema acá nunca debe demorar ni romper la respuesta de
// presencia real.
async function flagUnknownIdentity(ticketId: string, user: string, ticketNumber: string | null): Promise<void> {
  try {
    const dedupeKey = `identitycheck:${ticketId}:${user}`;
    const seen = await redis.get<string>(dedupeKey);
    if (seen) return;
    const resourceId = await lookupResourceId(user);
    if (resourceId !== null) return; // coincide con un técnico activo del roster
    await redis.set(dedupeKey, '1', { ex: 6 * 3600 });
    logCentralNotification({
      type: 'identity_mismatch',
      title: 'Nombre no reconocido en el roster',
      body: `"${user}" registró presencia en ${ticketNumber ?? `#${ticketId}`} pero no coincide con ningún técnico activo del roster sincronizado.`,
      ticketId,
      ticketNumber: ticketNumber ?? undefined,
      ts: Date.now(),
    });
  } catch {
    // best-effort, nunca debe afectar el flujo real de presencia
  }
}

// El MessageCard de Teams se manda con markdown:true — si ticketTitle/ticketNumber
// (vienen de Autotask, a veces copiados de un correo de cliente) o un nombre de
// técnico traen sintaxis Markdown, Teams lo renderiza como link/negrita real
// dentro de la alerta oficial. Se escapan los caracteres que Markdown interpreta
// antes de meterlos en cualquier campo del MessageCard.
function escapeTeamsMarkdown(s: string): string {
  return s.replace(/([\\`*_{}[\]()#+\-.!<>|])/g, '\\$1');
}

function postWebhook(webhookUrl: string, body: object) {
  fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).catch(() => {});
}

async function sendTeamsWebhook(ticketDisplayRaw: string, usersRaw: string[], ticketUrl?: string | null) {
  const webhookUrl = await getWebhookUrl();
  if (!webhookUrl) return;

  const ticketDisplay = escapeTeamsMarkdown(ticketDisplayRaw);
  const users = usersRaw.map(escapeTeamsMarkdown);
  const first = users[0];
  const rest = users.slice(1);
  postWebhook(webhookUrl, {
    '@type': 'MessageCard',
    '@context': 'http://schema.org/extensions',
    themeColor: 'dc2626',
    summary: `⚠️ Colisión en ${ticketDisplay}`,
    sections: [{
      activityTitle: `⚠️ Colisión detectada`,
      activitySubtitle: `${ticketDisplay} · Autotask CoView`,
      activityImage: 'https://netsus-two.vercel.app/icon/128.png',
      facts: [
        { name: 'Ticket', value: ticketUrl ? `<a href="${ticketUrl}">${ticketDisplay}</a>` : ticketDisplay },
        { name: 'Llegó primero', value: first },
        ...(rest.length ? [{ name: rest.length === 1 ? 'Entró después' : 'Entraron después', value: rest.join(', ') }] : []),
        { name: 'Hora', value: new Date().toLocaleString('es-CL') },
      ],
      markdown: true,
    }],
    potentialAction: ticketUrl ? [{ '@type': 'OpenUri', name: 'Abrir ticket', targets: [{ os: 'default', uri: ticketUrl }] }] : undefined,
  });
}

async function sendPingWebhook(ticketDisplayRaw: string, fromRaw: string, targetsRaw: string[], ticketUrl?: string | null) {
  const webhookUrl = await getWebhookUrl();
  if (!webhookUrl) return;

  const ticketDisplay = escapeTeamsMarkdown(ticketDisplayRaw);
  const from = escapeTeamsMarkdown(fromRaw);
  const targets = targetsRaw.map(escapeTeamsMarkdown);
  postWebhook(webhookUrl, {
    '@type': 'MessageCard',
    '@context': 'http://schema.org/extensions',
    themeColor: 'f97316',
    summary: `📣 ${from} te está esperando`,
    sections: [{
      activityTitle: `📣 ${from} necesita que termines`,
      activitySubtitle: `${ticketDisplay} · Autotask CoView`,
      activityImage: 'https://netsus-two.vercel.app/icon/128.png',
      facts: [
        { name: 'Ticket', value: ticketUrl ? `<a href="${ticketUrl}">${ticketDisplay}</a>` : ticketDisplay },
        { name: 'Esperando a', value: targets.join(', ') },
        { name: 'Hora', value: new Date().toLocaleString('es-CL') },
      ],
      markdown: true,
    }],
    potentialAction: ticketUrl ? [{ '@type': 'OpenUri', name: 'Abrir ticket', targets: [{ os: 'default', uri: ticketUrl }] }] : undefined,
  });
}

async function sendResolutionWebhook(ticketDisplayRaw: string, usersRaw: string[], durationMs: number, ticketUrl?: string | null) {
  const webhookUrl = await getWebhookUrl();
  if (!webhookUrl) return;

  const ticketDisplay = escapeTeamsMarkdown(ticketDisplayRaw);
  const users = usersRaw.map(escapeTeamsMarkdown);
  const durStr = formatDuration(durationMs);

  postWebhook(webhookUrl, {
    '@type': 'MessageCard',
    '@context': 'http://schema.org/extensions',
    themeColor: '16a34a',
    summary: `✅ Colisión resuelta en ${ticketDisplay}`,
    sections: [{
      activityTitle: `✅ Colisión resuelta`,
      activitySubtitle: `${ticketDisplay} · Autotask CoView`,
      activityImage: 'https://netsus-two.vercel.app/icon/128.png',
      facts: [
        { name: 'Ticket', value: ticketUrl ? `<a href="${ticketUrl}">${ticketDisplay}</a>` : ticketDisplay },
        { name: 'Técnicos', value: users.join(', ') },
        { name: 'Duración', value: durStr },
        { name: 'Hora', value: new Date().toLocaleString('es-CL') },
      ],
      markdown: true,
    }],
    potentialAction: ticketUrl ? [{ '@type': 'OpenUri', name: 'Abrir ticket', targets: [{ os: 'default', uri: ticketUrl }] }] : undefined,
  });
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!checkApiKey(request)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { id } = await params;
  if (!isValidTicketId(id)) return NextResponse.json({ error: 'invalid ticket id' }, { status: 400 });
  const keys = await redis.keys(`ticketpresence:${id}:*`);
  const users = keys.map(k => extractUser(k, id));
  return NextResponse.json({ users });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!checkApiKey(request)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { id } = await params;
  if (!isValidTicketId(id)) return NextResponse.json({ error: 'invalid ticket id' }, { status: 400 });
  const body = await request.json().catch(() => ({ user: 'Desconocido', ticketNumber: null, ticketTitle: null, ticketUrl: null, ping: null, quickMsg: null, autotaskTicketId: null }));
  const { ticketNumber, ticketTitle, ticketUrl, ping, quickMsg, autotaskTicketId } = body;
  // Nunca confiar en el nombre tal cual llega — termina en keys de Redis, en
  // Supabase (collision_history.users) y renderizado sin escapar en el panel
  // admin. Un nombre inválido (vacío, con HTML/script, demasiado largo) se
  // rechaza acá en vez de dejarlo colarse en el resto del sistema.
  const user = sanitizeUser(body.user);
  if (!user) return NextResponse.json({ error: 'invalid user' }, { status: 400 });
  // El sistema no autentica identidad — "quién eres" es un string self-reportado
  // (auto-detectado desde Autotask, o tipeado a mano). Bloquear duro contra el
  // roster acá dejaría a un técnico real con un nombre mal tipeado SIN detección
  // de colisión, en silencio (peor que el riesgo que se busca mitigar) — así que
  // esto solo deja traza para el admin, no rechaza la presencia. Fire-and-forget,
  // deduplicado 6h para no repetir el aviso en cada poll de 30s.
  flagUnknownIdentity(id, user, ticketNumber ?? null);

  if (autotaskTicketId) {
    const status = await getTicketStatus(String(autotaskTicketId));
    if (status !== null) {
      // Statuses cerrados: por defecto solo 5 (Complete). Configurable en Redis como
      // JSON array: SET config:closed_statuses "[5,8,29]"
      const closedRaw = await getCachedConfig('config:closed_statuses');
      const closedStatuses: number[] = closedRaw ? JSON.parse(closedRaw) : [AUTOTASK_STATUS_COMPLETE];
      if (closedStatuses.includes(status)) {
        // Aunque el ticket esté completado (solo lectura), el recurso principal sigue
        // siendo información útil de contexto — antes se devolvía assignedTo: null acá,
        // así que el sidepanel nunca mostraba "Recurso principal" en tickets cerrados.
        const [assignedTo, statusLabel] = await Promise.all([
          getAutotaskAssignee(String(autotaskTicketId)),
          getTicketStatusLabel(String(autotaskTicketId)),
        ]);
        return NextResponse.json({ ok: false, completed: true, others: [], assignedTo, statusLabel, assignedPresent: false, pingedBy: null, quickMsg: null, pastCollisions: 0 });
      }
    }
  }

  const configTtl = await getCachedConfig('config:presence_ttl');
  const ttl = clampInt(configTtl, 15, 300, PRESENCE_TTL);
  await redis.set(presenceKey(id, user), '1', { ex: ttl });
  // Refresca el score en cada poll — así el índice sabe que este ticket sigue
  // "vivo" sin depender de que nunca se llame DELETE (ej. el técnico cierra la
  // pestaña sin liberar).
  await redis.zadd(ACTIVE_TICKETS_KEY, { score: Date.now(), member: id });
  // nx: solo se fija la primera vez (conserva el momento real de llegada). El expire
  // aparte renueva el TTL en cada poll para que no venza a los 5 min y "reinicie" el
  // conteo de "quién llegó primero" en colisiones más largas que eso.
  await redis.set(`ticketentry:${id}:${user}`, Date.now().toString(), { ex: 300, nx: true });
  await redis.expire(`ticketentry:${id}:${user}`, 300);
  if (ticketNumber) await redis.set(`ticketnumber:${id}`, ticketNumber, { ex: 300 });
  if (ticketTitle) await redis.set(`tickettitle:${id}`, ticketTitle, { ex: 300 });
  if (ticketUrl) await redis.set(`ticketurl:${id}`, ticketUrl, { ex: 300, nx: true });
  // Cacheado para que el DELETE (que no recibe autotaskTicketId) pueda crear la
  // nota de resolución en el ticket numérico correcto.
  if (autotaskTicketId) await redis.set(`autotaskid:${id}`, String(autotaskTicketId), { ex: 300 });

  // Mismo criterio que `user`: los targets de ping son nombres de otros técnicos
  // que también terminan en keys de Redis y en el body de la notificación.
  const safePingTargets = Array.isArray(ping)
    ? (ping as unknown[]).map(sanitizeUser).filter((n): n is string => n !== null)
    : [];

  if (safePingTargets.length) {
    // Server-side rate limit: one ping per user per ticket every 30 seconds
    const pingRateKey = `pingrate:${id}:${user}`;
    const rateLimited = await redis.get(pingRateKey);
    if (!rateLimited) {
      await redis.set(pingRateKey, '1', { ex: 30 });
      const pingOps = safePingTargets.map((target) => redis.set(`ping:${id}:${target}`, user, { ex: 60 }));
      const qmsgOps = quickMsg
        ? safePingTargets.map((target) => redis.set(`quickmsg:${id}:${target}`, String(quickMsg).slice(0, 100), { ex: 120 }))
        : [];
      await Promise.all([...pingOps, ...qmsgOps]);
      const storedTicketNumber = ticketNumber ?? await redis.get<string>(`ticketnumber:${id}`);
      const storedUrl = ticketUrl ?? await redis.get<string>(`ticketurl:${id}`);
      sendPingWebhook(storedTicketNumber ?? `#${id}`, user, safePingTargets, storedUrl);
      logCentralNotification({
        type: 'ping',
        title: `${user} espera respuesta`,
        body: `Avisó a ${safePingTargets.join(', ')} en ${storedTicketNumber ?? `#${id}`}`,
        ticketId: id,
        ticketNumber: storedTicketNumber ?? undefined,
        ticketUrl: storedUrl ?? undefined,
        targets: safePingTargets,
        ts: Date.now(),
      });
    }
  }

  const pingKey = `ping:${id}:${user}`;
  const [pingedBy, quickMsgReceived] = await Promise.all([
    redis.get<string>(pingKey),
    redis.get<string>(`quickmsg:${id}:${user}`),
  ]);
  if (pingedBy) {
    await redis.del(pingKey);
    if (quickMsgReceived) await redis.del(`quickmsg:${id}:${user}`);
  }

  const allKeys = await redis.keys(`ticketpresence:${id}:*`);
  const otherNames = dedupeOthers(allKeys.map(k => extractUser(k, id)), user);

  const entryTimes = otherNames.length > 0
    ? await Promise.all(otherNames.map(u => redis.get<string>(`ticketentry:${id}:${u}`)))
    : [];

  const now = Date.now();
  const others = otherNames.map((name, i) => ({
    name,
    minutes: minutesSince(entryTimes[i], now),
  }));

  if (others.length > 0) {
    const colKey = `colactive:${id}:${user}`;
    // nx: true hace que esto sea el check-y-marca atómico — antes era un
    // GET seguido de un SET separado (check-then-act), así que dos requests
    // casi simultáneas para el mismo (ticket, user) podían leer "no marcado"
    // ambas y duplicar el webhook de Teams / la fila en collision_history.
    const firstToMark = await redis.set(colKey, '1', { ex: PRESENCE_TTL * 3, nx: true });
    if (firstToMark === 'OK') {
      const allInCollision = [user, ...otherNames];
      await Promise.all([
        redis.incr(`colcount:${id}`).then(() => redis.expire(`colcount:${id}`, 180 * 24 * 3600)),
        redis.set(`colstart:${id}`, Date.now().toString(), { ex: 600, nx: true }),
        redis.set(`colusers:${id}`, JSON.stringify(allInCollision), { ex: 600 }),
      ]);
      const storedUrl = ticketUrl ?? await redis.get<string>(`ticketurl:${id}`);
      const storedTitle = ticketTitle ?? await redis.get<string>(`tickettitle:${id}`);
      const ticketDisplay = storedTitle
        ? `${ticketNumber ?? `#${id}`} — ${storedTitle}`
        : (ticketNumber ?? `#${id}`);
      // Registro durable en Supabase (history/analytics/daily-summary leen de ahí) —
      // guardamos el id para completar duration_ms cuando se resuelva.
      try {
        const { data: supaRow } = await supabase
          .from('collision_history')
          .insert({
            ticket_id: id,
            ticket_number: ticketNumber ?? null,
            ticket_url: storedUrl ?? null,
            users: allInCollision,
          })
          .select('id')
          .single();
        if (supaRow) {
          await redis.set(`colsupaid:${id}`, supaRow.id, { ex: 600 });
          // Solo se vinculan los participantes que resuelven a un técnico real conocido.
          const resolved = await Promise.all(allInCollision.map(async (name) => ({ name, resource_id: await lookupResourceId(name) })));
          const participantRows = resolved
            .filter((r) => r.resource_id !== null)
            .map((r) => ({ collision_id: supaRow.id, resource_id: r.resource_id }));
          if (participantRows.length) await supabase.from('collision_participants').insert(participantRows);
        }
      } catch (e) {
        // Redis ya tiene el registro (la colisión se detecta igual) — pero si esto
        // falla seguido, el historial/analytics del panel admin queda incompleto
        // en silencio. Se deja rastro sin bloquear el resto del flujo.
        logError('presence:collision-insert', e, `ticket=${id}`);
      }
      if (await isWithinWorkHours()) sendTeamsWebhook(ticketDisplay, allInCollision, storedUrl);
      logCentralNotification({
        type: 'collision',
        title: 'Colisión detectada',
        body: `${allInCollision.join(', ')} coinciden en ${ticketDisplay}`,
        ticketId: id,
        ticketNumber: ticketNumber ?? undefined,
        ticketUrl: storedUrl ?? undefined,
        targets: allInCollision,
        ts: Date.now(),
      });
      maybeCreateAutotaskNote(
        autotaskTicketId ? String(autotaskTicketId) : id,
        `Colisión detectada — ${ticketNumber ?? `#${id}`}`,
        `Netsus CoView detectó que ${allInCollision.join(', ')} coincidieron trabajando este ticket al mismo tiempo. Registrado automáticamente.`,
      );
    } else {
      // Colisión ya en curso: renovamos los TTL de colactive/colstart en cada poll
      // (en vez de dejarlos vencer a los ~2 min) — si no, el servidor la trataba como
      // "nueva" cada ~2 minutos, reenviando el webhook de Teams, duplicando la fila en
      // collision_history/Supabase y truncando la duración real si pasaba de 10 min.
      const allInCollision = [user, ...otherNames];
      await Promise.all([
        redis.expire(colKey, PRESENCE_TTL * 3),
        redis.expire(`colstart:${id}`, 600),
        redis.set(`colusers:${id}`, JSON.stringify(allInCollision), { ex: 600 }),
      ]);
    }
  }

  const [assignedTo, pastCollisionsRaw, statusLabel] = await Promise.all([
    getAutotaskAssignee(autotaskTicketId ? String(autotaskTicketId) : id),
    redis.get<number>(`colcount:${id}`),
    autotaskTicketId ? getTicketStatusLabel(String(autotaskTicketId)) : Promise.resolve(null),
  ]);
  const pastCollisions = pastCollisionsRaw ?? 0;
  // El asignado puede estar entre los "otros" presentes ahora mismo — si es así,
  // no solo sabemos quién es el recurso principal, sino que está trabajándolo.
  const assignedPresent = assignedTo
    ? others.some((o) => o.name.trim().toLowerCase() === assignedTo.trim().toLowerCase())
    : false;

  return NextResponse.json({ ok: true, others, assignedTo: assignedTo ?? null, statusLabel, assignedPresent, pingedBy: pingedBy ?? null, quickMsg: quickMsgReceived ?? null, pastCollisions });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!checkApiKey(request)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { id } = await params;
  if (!isValidTicketId(id)) return NextResponse.json({ error: 'invalid ticket id' }, { status: 400 });
  const { user } = await request.json().catch(() => ({ user: '' }));
  if (typeof user === 'string' && user.trim()) {
    await redis.del(presenceKey(id, user));
    await redis.del(`ticketentry:${id}:${user}`);

    const remaining = await redis.keys(`ticketpresence:${id}:*`);
    if (remaining.length === 0) await redis.zrem(ACTIVE_TICKETS_KEY, id);
    if (remaining.length < 2) {
      const [startTs, colUsersRaw, ticketNumber, ticketTitle, ticketUrl] = await Promise.all([
        redis.get<string>(`colstart:${id}`),
        redis.get<string>(`colusers:${id}`),
        redis.get<string>(`ticketnumber:${id}`),
        redis.get<string>(`tickettitle:${id}`),
        redis.get<string>(`ticketurl:${id}`),
      ]);
      if (startTs) {
        const duration = Date.now() - parseInt(startTs);
        await Promise.all([
          redis.del(`colstart:${id}`),
          redis.del(`colusers:${id}`),
        ]);
        if (duration > 5000) {
          // Completa la fila de Supabase abierta en la detección; si no la encontramos
          // (TTL venció o se perdió), insertamos una fila nueva ya con la duración.
          try {
            const supaId = await redis.get<string>(`colsupaid:${id}`);
            const colUsersForSupa: string[] = colUsersRaw ? JSON.parse(colUsersRaw) : [user];
            if (supaId) {
              await supabase.from('collision_history').update({ duration_ms: duration }).eq('id', supaId);
              await redis.del(`colsupaid:${id}`);
            } else {
              await supabase.from('collision_history').insert({
                ticket_id: id,
                ticket_number: ticketNumber ?? null,
                ticket_url: ticketUrl ?? null,
                users: colUsersForSupa,
                duration_ms: duration,
              });
            }
          } catch (e) {
            logError('presence:collision-resolve', e, `ticket=${id}`);
          }
          // Notify Teams that the collision was resolved
          const colUsers: string[] = colUsersRaw ? JSON.parse(colUsersRaw) : [user];
          const resolutionDisplay = ticketTitle
            ? `${ticketNumber ?? `#${id}`} — ${ticketTitle}`
            : (ticketNumber ?? `#${id}`);
          if (await isWithinWorkHours()) sendResolutionWebhook(resolutionDisplay, colUsers, duration, ticketUrl);
          const durLabel = formatDuration(duration);
          logCentralNotification({
            type: 'liberation',
            title: 'Colisión resuelta',
            body: `${resolutionDisplay} liberado tras ${durLabel}`,
            ticketId: id,
            ticketNumber: ticketNumber ?? undefined,
            ticketUrl: ticketUrl ?? undefined,
            targets: colUsers,
            ts: Date.now(),
          });
          const cachedAutotaskId = await redis.get<string>(`autotaskid:${id}`);
          maybeCreateAutotaskNote(
            cachedAutotaskId ?? id,
            `Colisión resuelta — ${ticketNumber ?? `#${id}`}`,
            `${colUsers.join(', ')} coincidieron en este ticket durante ${durLabel}. Colisión resuelta automáticamente por Netsus CoView.`,
          );
        }
      }
    }
  }
  return NextResponse.json({ ok: true });
}
