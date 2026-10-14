// Poller server-side de n1–n5 + feed por recurso.
// Se ejecuta lock-guarded (un solo ciclo aunque lo disparen varios clientes/el cron).
// Calcula eventos relevantes por técnico y los deja en notif:feed:<resourceID>,
// que la extensión drena y vuelca en el buzón (lib/notifications de la extensión).

import { redis } from '@/lib/ticket-lock';
import { supabase } from '@/lib/supabase/client';
import { lookupResourceId, resourceNamesByIds } from '@/lib/supabase/resources';
import { clampInt } from '@/lib/num';
import {
  autotaskConfigured,
  allOpenTickets,
  ticketsAssignedTo,
  ticketsByIds,
  clientNotesSince,
  resolveResourceIdByName,
  resolveNameByResourceId,
  buildTicketUrl,
  type AutotaskTicket,
} from '@/lib/autotask';

// Log central de notificaciones — feed agregado de TODO el equipo (n1–n5 + eventos
// de colisión), independiente del feed por-recurso que cada extensión drena. Alimenta
// el tab "Centro de Notificaciones" del panel web (GET /api/notifications/log lee
// directo de Supabase, no de Redis — no hay lista intermedia que mantener aquí).

export interface CentralLogEntry {
  type: string;
  title: string;
  body: string;
  ticketId?: string;
  ticketNumber?: string;
  ticketUrl?: string;
  targets?: string[]; // nombres resueltos, best-effort
  ts: number;
}

export async function logCentralNotification(entry: CentralLogEntry): Promise<void> {
  // Una fila por destinatario (la tabla es por-técnico). Solo se guardan los que
  // resuelven a un técnico real conocido (evita que un nombre inventado quede
  // registrado). Best-effort — si Supabase falla, no bloqueamos el resto del poll.
  try {
    if (entry.targets?.length) {
      const resolved = await Promise.all(
        entry.targets.map(async (resource_name) => ({ resource_name, resource_id: await lookupResourceId(resource_name) })),
      );
      const rows = resolved
        .filter((r) => r.resource_id !== null)
        .map((r) => ({
          resource_name: r.resource_name,
          resource_id: r.resource_id,
          type: entry.type,
          title: entry.title,
          body: entry.body,
          ticket_id: entry.ticketId ?? null,
          ticket_number: entry.ticketNumber ?? null,
          ticket_url: entry.ticketUrl ?? null,
          read: false,
        }));
      if (rows.length) await supabase.from('notifications').insert(rows);
    } else {
      // Sin técnicos en línea para recibirla — igual queda una fila "huérfana" para
      // que el panel admin (Centro de Notificaciones) la vea, aunque nadie la reciba
      // en su feed. Sin esto, un ticket que entra a la cola fuera de horario (nadie
      // con la extensión abierta) no queda registro visible en ninguna parte.
      await supabase.from('notifications').insert([{
        resource_name: '(sin técnicos en línea)',
        resource_id: null,
        type: entry.type,
        title: entry.title,
        body: entry.body,
        ticket_id: entry.ticketId ?? null,
        ticket_number: entry.ticketNumber ?? null,
        ticket_url: entry.ticketUrl ?? null,
        read: false,
      }]);
    }
  } catch {
    // silencioso: no queremos que un problema de Supabase tumbe el ciclo de poll
  }
}

export type FeedType = 'n1_queue' | 'n2_assign' | 'n3_client' | 'n4_sla' | 'n5_critical';

export interface FeedItem {
  type: FeedType;
  title: string;
  body: string;
  ticketId: string;
  ticketNumber?: string;
  ticketUrl?: string;
  dedupeKey: string;
  ts: number;
}

const LOCK_KEY = 'notif:poll_lock';
// s — un ciclo por ventana. 120 y no 50: cada ciclo cuesta varios comandos Redis por
// técnico activo, y n1/n2/n5 ya llegan casi al instante por el webhook de Autotask;
// el poller es la red de seguridad (y la vía de n3/n4, que toleran 2 min de demora).
const LOCK_TTL_DEFAULT = 120;
const LASTPOLL_KEY = 'notif:lastpoll';
const ACTIVE_KEY = 'team:resources';   // ZSET member=resourceID, score=lastSeenMs
const ACTIVE_WINDOW_MS = 2 * 3600 * 1000;
const FEED_TTL = 24 * 3600;
const FEED_MAX = 50;

// --- Config (editable desde el panel admin) ---
function parseJsonNumbers(raw: unknown, fallback: number[]): number[] {
  if (!raw) return fallback;
  try {
    const arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(arr) ? arr.map(Number).filter((n) => !Number.isNaN(n)) : fallback;
  } catch {
    return fallback;
  }
}

export async function getNotifConfig() {
  const [criticalRaw, slaRaw, uiBase, enabledRaw] = await redis.mget<
    [unknown, string | null, string | null, string | null]
  >('config:critical_priorities', 'config:sla_warn_min', 'config:autotask_ui_base', 'config:notif_enabled');
  const slaWarnMin = clampInt(slaRaw, 5, 1440, 30);
  return {
    criticalPriorities: parseJsonNumbers(criticalRaw, [1]),
    slaWarnMin,
    uiBase: uiBase ?? null,
    enabled: String(enabledRaw) !== '0', // "0" vuelve deserializado como número 0
  };
}

// Cache en memoria por instancia (se pierde al reciclarse la función, no hay nada que
// limpiar). Para valores que cambian poco y se leían en CADA llamada de un endpoint
// que todos los técnicos llaman cada pocos segundos.
const memCache = new Map<string, { value: unknown; expires: number }>();
async function memoized<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const hit = memCache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value as T;
  const value = await load();
  memCache.set(key, { value, expires: Date.now() + ttlMs });
  return value;
}

// --- Recursos activos ---
// Llamada cada vez que un técnico consulta su feed (cada pocos segundos). El nombre→ID
// casi nunca cambia y la ventana de "activo" es de 2h, así que no hace falta pegarle a
// Redis en cada llamada: se resuelve el ID una vez cada 10 min y se refresca el score
// del ZSET como mucho cada 5 min por instancia.
const ZADD_THROTTLE_MS = 5 * 60 * 1000;
const lastZadd = new Map<number, number>();
export async function registerActiveResource(name: string): Promise<number | null> {
  const rid = await memoized(`rid:${name.toLowerCase()}`, 10 * 60 * 1000, () => resolveResourceIdByName(name));
  if (rid === null) return null;
  const now = Date.now();
  if (now - (lastZadd.get(rid) ?? 0) > ZADD_THROTTLE_MS) {
    await redis.zadd(ACTIVE_KEY, { score: now, member: String(rid) });
    lastZadd.set(rid, now);
  }
  return rid;
}

async function activeResourceIds(now: number): Promise<number[]> {
  const members = await redis.zrange<string[]>(ACTIVE_KEY, now - ACTIVE_WINDOW_MS, '+inf', { byScore: true });
  return (members ?? []).map(Number).filter((n) => !Number.isNaN(n));
}

// IDs de recursos con la extensión activa ahora — usado por el panel admin para
// marcar quién está "en línea" dentro del roster (distinto de "trabajando un ticket").
export async function activeResourceIdSet(): Promise<Set<number>> {
  return new Set(await activeResourceIds(Date.now()));
}

// Cuántos técnicos tienen la extensión activa (resolvieron nombre→resourceID) en la
// última ventana. Aproximación de "en línea" — usada para el stat "técnicos disponibles".
export async function activeTeamCount(): Promise<number> {
  const ids = await activeResourceIds(Date.now());
  return ids.length;
}

// --- Feed ---
export async function drainFeed(rid: number): Promise<FeedItem[]> {
  const key = `notif:feed:${rid}`;
  const items = await redis.lrange<string>(key, 0, -1);
  if (items.length) await redis.del(key);
  const parsed = items
    .map((s) => { try { return typeof s === 'string' ? JSON.parse(s) : s; } catch { return null; } })
    .filter(Boolean) as FeedItem[];
  // lpush deja lo más nuevo primero; devolvemos cronológico (viejo→nuevo).
  return parsed.reverse();
}

// Empuja un evento a varios recursos, deduplicando por dedupeKey (global) con TTL.
// resourceIDs puede venir vacío (nadie con la extensión activa ahora mismo) — igual
// se registra el evento (dedupe + log central) para que quede visible en el panel
// admin; solo se salta el push a feed por-técnico cuando no hay destinatarios.
// Exportado para que app/api/webhooks/autotask/route.ts pueda empujar n1/n2/n5 con el
// MISMO dedupe (notif:seen:<dedupeKey>) que usa el poll de abajo — así el webhook (más
// rápido) y la reconciliación periódica de runPoll() nunca duplican un aviso, sin
// necesidad de coordinarse entre sí más que compartiendo el formato de dedupeKey.
// Espejo en memoria de notif:seen:* — un ticket crítico o con SLA vencido sigue
// "disparando" en cada ciclo del poller hasta que se cierra, y cada vez costaba un
// SET NX solo para descubrir que ya estaba avisado. Si esta instancia ya lo vio, se
// salta Redis; si no (instancia nueva), cae al SET NX de siempre, que sigue siendo la
// fuente de verdad compartida.
const seenLocal = new Map<string, number>();
export async function pushEvent(resourceIDs: number[], item: FeedItem, seenTtlSec: number): Promise<boolean> {
  const seenKey = `notif:seen:${item.dedupeKey}`;
  const now = Date.now();
  if ((seenLocal.get(seenKey) ?? 0) > now) return false;
  const first = await redis.set(seenKey, '1', { ex: seenTtlSec, nx: true });
  if (seenLocal.size > 5000) for (const [k, exp] of seenLocal) if (exp <= now) seenLocal.delete(k);
  seenLocal.set(seenKey, now + seenTtlSec * 1000);
  if (first !== 'OK') return false; // ya emitido dentro de la ventana
  const payload = JSON.stringify(item);
  if (resourceIDs.length) {
    await Promise.all(resourceIDs.map(async (rid) => {
      const key = `notif:feed:${rid}`;
      await redis.lpush(key, payload);
      await redis.ltrim(key, 0, FEED_MAX - 1);
      await redis.expire(key, FEED_TTL);
    }));
  }

  const targets = resourceIDs.length
    ? (await Promise.all(resourceIDs.map((rid) => resolveNameByResourceId(rid)))).filter((n): n is string => n !== null)
    : [];
  await logCentralNotification({
    type: item.type,
    title: item.title,
    body: item.body,
    ticketId: item.ticketId,
    ticketNumber: item.ticketNumber,
    ticketUrl: item.ticketUrl,
    targets,
    ts: item.ts,
  });

  return true;
}

export function tParsed(s?: string | null): number | null {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

// SLA por vencer/vencido (n4): due presente, aún no cumplido, y dentro de la ventana de aviso.
export function slaEvents(t: AutotaskTicket, warnMin: number, now: number): { kind: string; label: string; overdue: boolean }[] {
  const out: { kind: string; label: string; overdue: boolean }[] = [];
  const warnMs = warnMin * 60000;
  const check = (kind: string, label: string, due?: string | null, met?: string | null) => {
    const dueMs = tParsed(due);
    if (dueMs === null || tParsed(met) !== null) return;
    if (dueMs - now <= warnMs) out.push({ kind, label, overdue: dueMs < now });
  };
  check('first', 'Primera respuesta', t.firstResponseDueDateTime, t.firstResponseDateTime);
  check('resolution', 'Resolución', t.resolutionDueDateTime, t.resolvedDateTime);
  return out;
}

// --- Poll principal ---
let lastLockAttempt = 0;
export async function runPoll(force = false): Promise<{ ran: boolean; counts?: Record<string, number> }> {
  if (!autotaskConfigured()) return { ran: false };

  // Dial preparado para cuando el webhook de Autotask (app/api/webhooks/autotask/)
  // lleve un tiempo confiable en producción — hoy sigue en 50s por defecto (sin
  // cambio de comportamiento) hasta que se suba a mano desde el panel admin.
  const lockTtlRaw = await memoized('notif_poll_interval', 60_000, () => redis.get<string>('config:notif_poll_interval_sec'));
  const lockTtl = clampInt(lockTtlRaw, 30, 3600, LOCK_TTL_DEFAULT);

  // runPoll() se llama de forma oportunista en CADA consulta de feed de cada técnico.
  // Si esta misma instancia ya intentó tomar el lock dentro de la ventana, el lock
  // sigue tomado (por ella o por otra) — no hace falta gastar un SET NX para saberlo.
  if (!force) {
    const now = Date.now();
    if (now - lastLockAttempt < lockTtl * 1000) return { ran: false };
    lastLockAttempt = now;
  }

  if (force) {
    await redis.set(LOCK_KEY, '1', { ex: lockTtl });
  } else {
    const got = await redis.set(LOCK_KEY, '1', { ex: lockTtl, nx: true });
    if (got !== 'OK') return { ran: false }; // otro ciclo en curso
  }

  const cfg = await getNotifConfig();
  if (!cfg.enabled) return { ran: false };

  const now = Date.now();
  const lastPoll = Number(await redis.get<string>(LASTPOLL_KEY)) || (now - 5 * 60000);
  const sinceIso = new Date(lastPoll - 60000).toISOString(); // buffer de 1 min por desfases de TZ
  const arrivalCutoff = lastPoll - 120000;                    // buffer de 2 min para n1
  const uiUrl = (id: number) => buildTicketUrl(cfg.uiBase, id);
  const counts: Record<string, number> = { n1: 0, n2: 0, n3: 0, n4: 0, n5: 0 };

  const resources = await activeResourceIds(now);

  // n1 (entrante) + n5 (crítico) en TODAS las colas → a todos los recursos activos.
  // Se revisa aunque no haya técnicos con la extensión abierta ahora mismo (resources
  // vacío): pushEvent igual deja el evento en el log central para que el panel admin
  // lo vea; solo se salta el feed por-técnico si no hay destinatarios.
  {
    const qTickets = await allOpenTickets();
    // Nombres de los asignados de los tickets nuevos, en una sola query — evita
    // una llamada a Supabase por ticket dentro del loop de abajo.
    const newTickets = qTickets.filter((t) => {
      const createdMs = tParsed(t.createDate);
      return createdMs !== null && createdMs >= arrivalCutoff;
    });
    const assigneeIds = newTickets.map((t) => t.assignedResourceID).filter((id): id is number => id != null);
    const assigneeNames = await resourceNamesByIds(assigneeIds);

    for (const t of qTickets) {
      const label = t.ticketNumber || `#${t.id}`;
      const createdMs = tParsed(t.createDate);
      if (createdMs !== null && createdMs >= arrivalCutoff) {
        const assigneeName = t.assignedResourceID != null ? assigneeNames.get(t.assignedResourceID) : undefined;
        const assigneeSuffix = ` — ${assigneeName ? `asignado a ${assigneeName}` : 'sin asignar'}`;
        const ok = await pushEvent(resources, {
          type: 'n1_queue', title: 'Nuevo ticket en la cola',
          body: `${label}${t.title ? ' · ' + t.title : ''} entró en la cola${assigneeSuffix}`,
          ticketId: String(t.id), ticketNumber: t.ticketNumber, ticketUrl: uiUrl(t.id),
          dedupeKey: `n1:${t.id}`, ts: now,
        }, 6 * 3600);
        if (ok) counts.n1++;
      }
      if (t.priority !== undefined && cfg.criticalPriorities.includes(t.priority)) {
        const ok = await pushEvent(resources, {
          type: 'n5_critical', title: 'Ticket crítico en la cola',
          body: `${label}${t.title ? ' · ' + t.title : ''} es crítico y está en la cola`,
          ticketId: String(t.id), ticketNumber: t.ticketNumber, ticketUrl: uiUrl(t.id),
          dedupeKey: `n5:${t.id}`, ts: now,
        }, 6 * 3600);
        if (ok) counts.n5++;
      }
    }
  }

  // n2 (asignación) + n4 (SLA) en tickets asignados a recursos activos.
  if (resources.length) {
    const aTickets = await ticketsAssignedTo(resources);
    const byResource = new Map<number, AutotaskTicket[]>();
    for (const t of aTickets) {
      if (t.assignedResourceID == null) continue;
      const arr = byResource.get(t.assignedResourceID) ?? [];
      arr.push(t);
      byResource.set(t.assignedResourceID, arr);
    }

    // Antes era un for..of con awaits secuenciales — cada recurso hacía varios
    // round-trips a Redis uno detrás del otro. Con equipos grandes esto podía
    // acercarse (o superar) el TTL de 50s del lock del poller, dejando que un
    // segundo ciclo arrancara en paralelo con el primero. Promise.all no cambia
    // el resultado (JS no tiene carreras reales en los contadores porque nunca
    // hay dos callbacks corriendo literalmente al mismo tiempo), solo evita que
    // el ciclo entero espere a cada recurso en serie.
    const perResourceCounts = await Promise.all(resources.map(async (rid) => {
      const mine = byResource.get(rid) ?? [];
      const knownKey = `notif:known_assigned:${rid}`;
      const known = new Set((await redis.smembers(knownKey)).map(String));
      const currentIds = mine.map((t) => String(t.id));
      let n2 = 0;
      let n4 = 0;

      // Primera vez que vemos a este recurso: sembrar sin notificar (evita avalancha inicial).
      const seeded = known.size > 0 || (await redis.get<string>(`notif:seeded:${rid}`)) === '1';
      for (const t of mine) {
        if (seeded && !known.has(String(t.id))) {
          const label = t.ticketNumber || `#${t.id}`;
          const ok = await pushEvent([rid], {
            type: 'n2_assign', title: 'Ticket asignado a ti',
            body: `Se te asignó ${label}${t.title ? ' · ' + t.title : ''}`,
            ticketId: String(t.id), ticketNumber: t.ticketNumber, ticketUrl: uiUrl(t.id),
            dedupeKey: `n2:${rid}:${t.id}`, ts: now,
          }, 24 * 3600);
          if (ok) n2++;
        }
      }
      // Actualiza el set conocido — solo si cambió. Antes se reescribía entero (DEL +
      // SADD + EXPIRE + SET) en cada ciclo para cada técnico aunque nada hubiera
      // cambiado, que era el grueso del costo del poller. TTL de 30 días porque ya no se
      // renueva en cada ciclo: tiene que sobrevivir semanas sin cambios de asignación.
      const changed = currentIds.length !== known.size || currentIds.some((id) => !known.has(id));
      if (changed) {
        await redis.del(knownKey);
        if (currentIds.length) {
          await redis.sadd(knownKey, currentIds[0], ...currentIds.slice(1));
          await redis.expire(knownKey, 30 * 24 * 3600);
        }
      }
      if (changed || !seeded) await redis.set(`notif:seeded:${rid}`, '1', { ex: 30 * 24 * 3600 });

      // n4 SLA
      for (const t of mine) {
        for (const e of slaEvents(t, cfg.slaWarnMin, now)) {
          const label = t.ticketNumber || `#${t.id}`;
          const ok = await pushEvent([rid], {
            type: 'n4_sla', title: e.overdue ? `SLA vencido · ${e.label}` : `SLA por vencer · ${e.label}`,
            body: `${label}${t.title ? ' · ' + t.title : ''} — ${e.label} ${e.overdue ? 'ya venció' : 'está por vencer'}`,
            ticketId: String(t.id), ticketNumber: t.ticketNumber, ticketUrl: uiUrl(t.id),
            dedupeKey: `n4:${t.id}:${e.kind}`, ts: now,
          }, 6 * 3600);
          if (ok) n4++;
        }
      }
      return { n2, n4 };
    }));
    for (const c of perResourceCounts) {
      counts.n2 += c.n2;
      counts.n4 += c.n4;
    }
  }

  // n3 (respuesta de cliente) — notas de contacto desde el último poll, al técnico asignado.
  const notes = await clientNotesSince(sinceIso);
  if (notes.length && resources.length) {
    const ticketIds = [...new Set(notes.map((n) => n.ticketID))];
    const noteTickets = await ticketsByIds(ticketIds);
    const byId = new Map(noteTickets.map((t) => [t.id, t]));
    const activeSet = new Set(resources);
    for (const note of notes) {
      const t = byId.get(note.ticketID);
      if (!t || t.assignedResourceID == null || !activeSet.has(t.assignedResourceID)) continue;
      const label = t.ticketNumber || `#${t.id}`;
      const ok = await pushEvent([t.assignedResourceID], {
        type: 'n3_client', title: 'Respuesta de cliente',
        body: `El cliente respondió en ${label}${t.title ? ' · ' + t.title : ''}`,
        ticketId: String(t.id), ticketNumber: t.ticketNumber, ticketUrl: uiUrl(t.id),
        dedupeKey: `n3:${note.id}`, ts: now,
      }, 24 * 3600);
      if (ok) counts.n3++;
    }
  }

  await redis.set(LASTPOLL_KEY, String(now));
  return { ran: true, counts };
}
