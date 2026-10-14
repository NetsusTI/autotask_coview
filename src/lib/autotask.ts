// Helpers server-side para la API REST de Autotask.
// El secreto (AUTOTASK_SECRET) vive solo en las env de Vercel — nunca en la extensión.
// La zona (webservices12) se mantiene igual que el resto del proyecto (getAutotaskAssignee).

import { redis } from '@/lib/ticket-lock';

// Exportado: app/api/webhooks/autotask/register/route.ts lo necesita para hablarle
// directo a TicketWebhooks/TicketWebhookFields (entidades que el resto de este archivo
// no cubre, `query()` solo sabe de Tickets/TicketNotes/Resources).
export const BASE = 'https://webservices12.autotask.net/ATServicesRest/v1.0';

export function autotaskConfigured(): boolean {
  return Boolean(process.env.AUTOTASK_USER && process.env.AUTOTASK_SECRET && process.env.AUTOTASK_INTEGRATION_CODE);
}

export function headers(): Record<string, string> {
  return {
    ApiIntegrationCode: process.env.AUTOTASK_INTEGRATION_CODE ?? '',
    UserName: process.env.AUTOTASK_USER ?? '',
    Secret: process.env.AUTOTASK_SECRET ?? '',
    'Content-Type': 'application/json',
  };
}

// --- Tipos de filtro (formato REST de Autotask) ---
export type Filter =
  | { op: 'eq' | 'noteq' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'beginsWith'; field: string; value: string | number | boolean }
  | { op: 'in' | 'notIn'; field: string; value: (string | number)[] }
  | { op: 'exist' | 'notExist'; field: string }
  | { op: 'and' | 'or'; items: Filter[] };

interface QueryBody {
  MaxRecords?: number;
  IncludeFields?: string[];
  Filter: Filter[];
}

// Ejecuta {Entity}/query. Devuelve items (array) o [] ante cualquier error.
export async function query<T = Record<string, unknown>>(
  entity: 'Tickets' | 'TicketNotes' | 'Resources',
  body: QueryBody,
): Promise<T[]> {
  if (!autotaskConfigured()) return [];
  try {
    const res = await fetch(`${BASE}/${entity}/query`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data?.items) ? (data.items as T[]) : [];
  } catch {
    return [];
  }
}

export interface AutotaskTicket {
  id: number;
  ticketNumber?: string;
  title?: string;
  queueID?: number;
  status?: number;
  priority?: number;
  assignedResourceID?: number | null;
  createDate?: string;
  lastActivityDate?: string;
  firstResponseDueDateTime?: string | null;
  firstResponseDateTime?: string | null;
  resolutionPlanDueDateTime?: string | null;
  resolutionPlanDateTime?: string | null;
  resolutionDueDateTime?: string | null;
  resolvedDateTime?: string | null;
}

const TICKET_FIELDS = [
  'id', 'ticketNumber', 'title', 'queueID', 'status', 'priority', 'assignedResourceID',
  'createDate', 'lastActivityDate',
  'firstResponseDueDateTime', 'firstResponseDateTime',
  'resolutionPlanDueDateTime', 'resolutionPlanDateTime',
  'resolutionDueDateTime', 'resolvedDateTime',
];

// Status 5 = Complete en la configuración por defecto de Autotask. Tickets "abiertos" = ≠ 5.
const STATUS_COMPLETE = 5;

// Tickets abiertos en las colas vigiladas (para n1 entrante y n5 crítico).
export async function ticketsInQueues(queueIDs: number[], maxRecords = 200): Promise<AutotaskTicket[]> {
  if (!queueIDs.length) return [];
  return query<AutotaskTicket>('Tickets', {
    MaxRecords: maxRecords,
    IncludeFields: TICKET_FIELDS,
    Filter: [
      { op: 'and', items: [
        { op: 'in', field: 'queueID', value: queueIDs },
        { op: 'noteq', field: 'status', value: STATUS_COMPLETE },
      ] },
    ],
  });
}

// Todos los tickets abiertos, sin filtrar por cola — usado cuando la vigilancia
// de n1/n5 está en modo automático (todas las colas) en vez de una lista manual.
export async function allOpenTickets(maxRecords = 500): Promise<AutotaskTicket[]> {
  return query<AutotaskTicket>('Tickets', {
    MaxRecords: maxRecords,
    IncludeFields: TICKET_FIELDS,
    Filter: [{ op: 'noteq', field: 'status', value: STATUS_COMPLETE }],
  });
}

// Tickets abiertos asignados a un conjunto de recursos (para n2 asignación y n4 SLA).
export async function ticketsAssignedTo(resourceIDs: number[], maxRecords = 300): Promise<AutotaskTicket[]> {
  if (!resourceIDs.length) return [];
  return query<AutotaskTicket>('Tickets', {
    MaxRecords: maxRecords,
    IncludeFields: TICKET_FIELDS,
    Filter: [
      { op: 'and', items: [
        { op: 'in', field: 'assignedResourceID', value: resourceIDs },
        { op: 'noteq', field: 'status', value: STATUS_COMPLETE },
      ] },
    ],
  });
}

// Tickets resueltos por un conjunto de recursos desde `sinceIso` — para el panel de
// carga por técnico (tiempo promedio de resolución reciente, no histórico completo).
export async function closedTicketsAssignedTo(resourceIDs: number[], sinceIso: string, maxRecords = 500): Promise<AutotaskTicket[]> {
  if (!resourceIDs.length) return [];
  return query<AutotaskTicket>('Tickets', {
    MaxRecords: maxRecords,
    IncludeFields: TICKET_FIELDS,
    Filter: [
      { op: 'and', items: [
        { op: 'in', field: 'assignedResourceID', value: resourceIDs },
        { op: 'eq', field: 'status', value: STATUS_COMPLETE },
        { op: 'gte', field: 'lastActivityDate', value: sinceIso },
      ] },
    ],
  });
}

// Tickets por lista de IDs (para mapear notas de cliente → ticket/asignado en n3).
export async function ticketsByIds(ids: number[], maxRecords = 200): Promise<AutotaskTicket[]> {
  if (!ids.length) return [];
  return query<AutotaskTicket>('Tickets', {
    MaxRecords: maxRecords,
    IncludeFields: TICKET_FIELDS,
    Filter: [{ op: 'in', field: 'id', value: ids }],
  });
}

export interface AutotaskNote {
  id: number;
  ticketID: number;
  createDateTime?: string;
  lastActivityDate?: string;
  createdByContactID?: number | null;
  title?: string;
}

// Notas creadas por un contacto (cliente) desde `sinceIso` — señal de "respuesta de cliente" (n3).
export async function clientNotesSince(sinceIso: string, maxRecords = 200): Promise<AutotaskNote[]> {
  return query<AutotaskNote>('TicketNotes', {
    MaxRecords: maxRecords,
    IncludeFields: ['id', 'ticketID', 'createDateTime', 'createdByContactID', 'title'],
    Filter: [
      { op: 'and', items: [
        { op: 'gte', field: 'createDateTime', value: sinceIso },
        { op: 'exist', field: 'createdByContactID' },
      ] },
    ],
  });
}

interface AutotaskResource {
  id: number;
  firstName?: string;
  lastName?: string;
  isActive?: boolean;
}

// Resuelve "Nombre Apellido" → resourceID consultando Resources, con cache en Redis (7 días).
// Cachea '' cuando no hay match para no reconsultar en cada ciclo.
export async function resolveResourceIdByName(fullName: string): Promise<number | null> {
  const clean = fullName.trim();
  if (!clean) return null;
  const cacheKey = `resource:byname:${clean.toLowerCase()}`;
  const cached = await redis.get<string>(cacheKey);
  if (cached !== null && cached !== undefined) return cached === '' ? null : Number(cached);

  const parts = clean.split(/\s+/);
  const firstName = parts[0];
  const lastName = parts.slice(1).join(' ');

  const filter: Filter[] = lastName
    ? [{ op: 'and', items: [
        { op: 'eq', field: 'firstName', value: firstName },
        { op: 'eq', field: 'lastName', value: lastName },
      ] }]
    : [{ op: 'eq', field: 'firstName', value: firstName }];

  const resources = await query<AutotaskResource>('Resources', {
    MaxRecords: 5,
    IncludeFields: ['id', 'firstName', 'lastName', 'isActive'],
    Filter: filter,
  });

  const match = resources.find((r) => r.isActive) ?? resources[0];
  const id = match?.id ?? null;
  await redis.set(cacheKey, id === null ? '' : String(id), { ex: 7 * 24 * 3600 });
  if (id !== null) await redis.set(`resource:byid:${id}`, clean, { ex: 7 * 24 * 3600 });
  return id;
}

// Reverso del cache anterior — nombre a mostrar para un resourceID ya resuelto antes.
// Best-effort: si nunca se resolvió ese ID, devuelve null (no dispara una consulta nueva).
export async function resolveNameByResourceId(id: number): Promise<string | null> {
  return redis.get<string>(`resource:byid:${id}`);
}

export interface AutotaskActiveResource {
  id: number;
  firstName: string;
  lastName: string;
  email?: string | null;
  title?: string | null;
}

// Cuentas de servicio/integración/API que Autotask sí marca isActive pero que no
// corresponden a un técnico humano — no hay un campo confiable en la API REST para
// distinguirlas estructuralmente (el "Tipo de licencia"/"Nivel de seguridad" que se
// ve en la UI no viene expuesto en Resources/query), así que se filtran por patrón
// de nombre/email. No es infalible: para gente real en áreas no técnicas (admin,
// marketing, comercial) que no calza con ningún patrón acá, usar "Quitar del roster"
// en el panel admin (tab Recursos → Roster sincronizado).
const SERVICE_ACCOUNT_PATTERN = /\b(api|integraci[oó]n|proceso|rocketcyber|quickbook|saas\s*alert|accounting\s*hub|power\s*automate|uni\s*view|dark\s*web|\bedr\b|\brmm\b|notificaciones\s*teams|consumo|coview|decambio|webhook|\bbot\b)\b/i;

function isServiceAccount(firstName: string, lastName: string, email: string | null | undefined): boolean {
  const haystack = `${firstName} ${lastName} ${email ?? ''}`.toLowerCase();
  if (/^autotask\s+administrador$/i.test(`${firstName} ${lastName}`.trim())) return true;
  return SERVICE_ACCOUNT_PATTERN.test(haystack);
}

// Técnicos activos en Autotask — roster fuente de verdad para sincronizar la tabla
// `resources` de Supabase (validar que un nombre corresponde a un técnico real).
export async function activeResources(maxRecords = 500): Promise<AutotaskActiveResource[]> {
  const resources = await query<AutotaskResource & { email?: string; title?: string }>('Resources', {
    MaxRecords: maxRecords,
    IncludeFields: ['id', 'firstName', 'lastName', 'email', 'title', 'isActive'],
    Filter: [{ op: 'eq', field: 'isActive', value: true }],
  });
  return resources
    .filter((r) => r.firstName || r.lastName)
    .filter((r) => !isServiceAccount(r.firstName ?? '', r.lastName ?? '', r.email))
    .map((r) => ({
      id: r.id,
      firstName: r.firstName ?? '',
      lastName: r.lastName ?? '',
      email: r.email ?? null,
      title: r.title ?? null,
    }));
}

// URL del ticket en la UI de Autotask, si se configuró la base (config:autotask_ui_base).
export function buildTicketUrl(uiBase: string | null, ticketId: number): string | undefined {
  if (!uiBase) return undefined;
  const base = uiBase.replace(/\/+$/, '');
  return `${base}/Mvc/ServiceDesk/TicketDetail.mvc?ticketId=${ticketId}`;
}

// Recurso asignado a un ticket — reemplaza el fetch inline que vivía duplicado
// en app/api/presence/[id]/route.ts (mismo BASE/headers, ya centralizados acá).
export async function getTicketAssignedResourceId(ticketId: string): Promise<number | null> {
  if (!autotaskConfigured()) return null;
  try {
    const res = await fetch(`${BASE}/Tickets/${ticketId}?fields=assignedResourceID`, { headers: headers() });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.item?.assignedResourceID ?? null;
  } catch {
    return null;
  }
}

// Status numérico del ticket — cacheado 90 s para detectar cambios sin martillar la API.
// Status 5 = Complete en Autotask por defecto.
export const AUTOTASK_STATUS_COMPLETE = 5;

// cachedValue: el valor de `ticketstatus:{id}` si el caller ya lo leyó en un MGET
// (hot path de POST /api/presence/[id]) — evita repetir el GET.
export async function getTicketStatus(autotaskId: string, cachedValue?: unknown): Promise<number | null> {
  if (!autotaskConfigured()) return null;
  const cacheKey = `ticketstatus:${autotaskId}`;
  const cached = cachedValue !== undefined ? cachedValue : await redis.get<string>(cacheKey);
  if (cached !== null && cached !== undefined) return cached === '' ? null : Number(cached);
  try {
    const res = await fetch(`${BASE}/Tickets/${autotaskId}?fields=status`, { headers: headers() });
    if (!res.ok) { await redis.set(cacheKey, '', { ex: 90 }); return null; }
    const data = await res.json();
    const status: number | null = data?.item?.status ?? null;
    await redis.set(cacheKey, status === null ? '' : String(status), { ex: 90 });
    return status;
  } catch {
    return null;
  }
}

// Aplica un cambio empujado por el webhook de Autotask (ver app/api/webhooks/autotask/
// route.ts) directamente a las mismas keys/TTLs que ya mantienen getTicketStatus() de
// acá arriba y getAutotaskAssignee() en app/api/presence/[id]/route.ts — así esa ruta
// no necesita ningún cambio: simplemente encuentra la caché caliente más seguido.
//
// `known.*` son valores que el caller pudo extraer con confianza del payload (ver
// extractFieldValue() en autotask-webhook.ts) — esos se escriben directo. Para un campo
// que Autotask marcó como cambiado pero cuyo valor no se pudo extraer del payload (el
// formato exacto de "Fields" no está 100% documentado), `invalidateIfUnknown` borra esa
// key de caché en vez de arriesgarse a dejarla con un valor viejo/incorrecto — el
// próximo GET la re-consulta a Autotask (mismo fallback de siempre, solo que ahora
// dispara antes en vez de esperar el TTL completo).
//
// A propósito NO llama a Autotask para resolver el nombre del recurso asignado (sería
// ir contra el propósito de la migración) — si resolveNameByResourceId() no lo tiene
// en caché, se invalida en vez de adivinar.
export interface WebhookTicketFields {
  id: number;
  status: number | null;
  assignedResourceID: number | null;
  priority: number | null;
}

export async function applyWebhookTicketUpdate(
  id: number,
  known: { status?: number | null; assignedResourceID?: number | null; priority?: number | null },
  invalidateIfUnknown: { status?: boolean; assignedResourceID?: boolean } = {},
): Promise<WebhookTicketFields> {
  const ops: Promise<unknown>[] = [];
  const statusKey = `ticketstatus:${id}`;
  const assignedKey = `ticketassigned:${id}`;

  if (known.status !== undefined) {
    ops.push(redis.set(statusKey, known.status === null ? '' : String(known.status), { ex: 90 }));
  } else if (invalidateIfUnknown.status) {
    ops.push(redis.del(statusKey));
  }

  if (known.assignedResourceID !== undefined) {
    if (known.assignedResourceID === null) {
      ops.push(redis.del(assignedKey)); // se desasignó
    } else {
      // resolveNameByResourceId (arriba en este archivo) es solo Redis — nunca llama a
      // Autotask. Si no lo tiene, se invalida en vez de dejar el nombre anterior.
      const name = await resolveNameByResourceId(known.assignedResourceID);
      if (name !== null) ops.push(redis.set(assignedKey, name, { ex: 300 }));
      else ops.push(redis.del(assignedKey));
    }
  } else if (invalidateIfUnknown.assignedResourceID) {
    ops.push(redis.del(assignedKey));
  }

  await Promise.all(ops);

  return {
    id,
    status: known.status ?? null,
    assignedResourceID: known.assignedResourceID ?? null,
    priority: known.priority ?? null,
  };
}

// Nombre real de cada status (picklist propio de cada instancia de Autotask — "1"
// puede ser "Nuevo" en una cuenta y otra cosa en otra, así que no se puede
// hardcodear). Se trae una sola vez de entityInformation/fields y se cachea 24h,
// porque los picklists casi no cambian.
const STATUS_LABEL_CACHE_KEY = 'autotask:status_labels';

// Además del cache de 24h en Redis, una copia en memoria por instancia: se consultaba
// en cada poll de presencia de cada técnico, para un dato que cambia una vez al año.
let statusLabelMem: { map: Record<number, string>; expires: number } | null = null;

async function getStatusLabelMap(): Promise<Record<number, string>> {
  if (statusLabelMem && statusLabelMem.expires > Date.now()) return statusLabelMem.map;
  const map = await loadStatusLabelMap();
  if (Object.keys(map).length) statusLabelMem = { map, expires: Date.now() + 3600 * 1000 };
  return map;
}

async function loadStatusLabelMap(): Promise<Record<number, string>> {
  // @upstash/redis ya devuelve el JSON parseado como objeto — un JSON.parse() sobre eso
  // tiraba siempre, y el mapa se volvía a pedir a Autotask (y a reescribir en Redis) en
  // cada llamada en vez de leerse del cache.
  const cached = await redis.get<Record<number, string> | string>(STATUS_LABEL_CACHE_KEY);
  if (cached && typeof cached === 'object') return cached;
  if (typeof cached === 'string' && cached) {
    try { return JSON.parse(cached); } catch { /* recae en refetch */ }
  }
  if (!autotaskConfigured()) return {};
  try {
    const res = await fetch(`${BASE}/Tickets/entityInformation/fields`, { headers: headers() });
    if (!res.ok) return {};
    const data = await res.json();
    const fields: { name?: string; picklistValues?: { value?: string; label?: string }[] }[] = data?.fields ?? [];
    const statusField = fields.find((f) => f.name === 'status');
    const map: Record<number, string> = {};
    for (const pv of statusField?.picklistValues ?? []) {
      const id = Number(pv.value);
      if (!Number.isNaN(id) && pv.label) map[id] = pv.label;
    }
    await redis.set(STATUS_LABEL_CACHE_KEY, JSON.stringify(map), { ex: 24 * 3600 });
    return map;
  } catch {
    return {};
  }
}

// Combina getTicketStatus() con el nombre real del picklist — null si no se pudo
// resolver cualquiera de los dos (ticket no encontrado, credenciales, etc).
export async function getTicketStatusLabel(autotaskId: string): Promise<string | null> {
  return statusLabelFor(await getTicketStatus(autotaskId));
}

// Igual que getTicketStatusLabel, pero con el status ya resuelto (sin volver a leerlo).
export async function statusLabelFor(status: number | null): Promise<string | null> {
  if (status === null) return null;
  const labels = await getStatusLabelMap();
  return labels[status] ?? null;
}

// Nombre completo de un recurso por su ID — usado junto con getTicketAssignedResourceId.
export async function getResourceName(resourceId: number): Promise<string | null> {
  if (!autotaskConfigured()) return null;
  try {
    const res = await fetch(`${BASE}/Resources/${resourceId}?fields=firstName,lastName`, { headers: headers() });
    if (!res.ok) return null;
    const data = await res.json();
    const item = data?.item;
    const name = item ? `${item.firstName ?? ''} ${item.lastName ?? ''}`.trim() : '';
    return name || null;
  } catch {
    return null;
  }
}

// Crea una nota en el ticket (registro de colisión detectada/resuelta). Nunca lanza
// — devuelve false ante cualquier error o si Autotask no está configurado, mismo
// contrato que el resto de este archivo (para poder llamarse fire-and-forget sin
// try/catch extra en el caller).
//
// noteType/publish son valores de picklist propios de cada instancia de Autotask —
// no hay forma de confirmarlos sin acceso a la instancia real. Se usan defaults
// conservadores (publish=1: nota interna, no visible al cliente en el portal) y
// esta función queda detrás de config:autotask_notes_enabled (apagado por defecto)
// hasta validarlos contra el entorno productivo real.
export async function createTicketNote(
  ticketId: number,
  note: { title: string; description: string },
): Promise<boolean> {
  if (!autotaskConfigured()) return false;
  try {
    const res = await fetch(`${BASE}/TicketNotes`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        item: {
          ticketID: ticketId,
          title: note.title,
          description: note.description,
          noteType: 1,
          publish: 1,
        },
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
