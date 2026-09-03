// Store centralizado del centro de notificaciones ("Autotask COLview").
// Único buzón compartido entre content script y popup vía chrome.storage.local.
// Aquí aterrizan tanto los eventos actuales (colisión, ping, liberación) como
// las fuentes futuras n1–n5 (cola, asignación, respuesta cliente, SLA, crítico).

import type { IconName } from './icons';

export type NotifType =
  | 'collision'
  | 'ping'
  | 'liberation'
  | 'n1_queue'
  | 'n2_assign'
  | 'n3_client'
  | 'n4_sla'
  | 'n5_critical';

export type Severity = 'info' | 'warning' | 'critical' | 'success';

export interface AppNotification {
  id: string;
  type: NotifType;
  severity: Severity;
  title: string;
  body: string;
  icon: IconName;
  ticketId?: string;
  ticketNumber?: string;
  ticketUrl?: string;
  ts: number;
  read: boolean;   // el técnico ya la abrió/leyó
  seen: boolean;   // ya se mostró el "aviso" (toast) — no volver a sonar
  dedupeKey?: string;
}

// Metadatos por tipo: severidad e icono.
//
// Hubo un mecanismo de re-nag acá (repetir sonido + pop-up nativo cada
// netsus_renag_min mientras algo quedara sin leer) que se sacó del todo a pedido
// explícito del admin — se sentía como que "salta la notificación cada cierto rato"
// sin que hubiera forma de ajustarlo desde el panel (esos controles ya se habían
// sacado de la UI antes, ver entrypoints/sidepanel/index.html). Si hace falta volver
// a insistir en algo urgente sin leer, mejor una franja horaria de trabajo/hasOpenTab
// que un timer ciego — no un simple "poner el número de vuelta".
export const TYPE_META: Record<NotifType, { severity: Severity; icon: IconName; label: string }> = {
  collision:   { severity: 'critical', icon: 'alert-triangle', label: 'Colisión' },
  ping:        { severity: 'warning',  icon: 'megaphone',      label: 'Aviso de técnico' },
  liberation:  { severity: 'success',  icon: 'check-circle',   label: 'Ticket liberado' },
  n1_queue:    { severity: 'info',     icon: 'inbox',          label: 'Ticket entrante en cola' },
  n2_assign:   { severity: 'warning',  icon: 'user-plus',      label: 'Asignación de ticket' },
  n3_client:   { severity: 'warning',  icon: 'message-square', label: 'Respuesta de cliente' },
  n4_sla:      { severity: 'critical', icon: 'timer',          label: 'SLA comprometido' },
  n5_critical: { severity: 'critical', icon: 'flame',          label: 'Ticket crítico en cola' },
};

// Tipos que se avisan SOLO visualmente (toast + badge), nunca con sonido — a pedido
// explícito del admin: un ticket entrando a la cola es un evento de alto volumen
// (varios por hora en horario pico) y sonar por cada uno resultaba más ruido que
// aviso útil. No usa el mecanismo de mute por técnico (TypePrefs/isMuted): es un
// default del sistema, no algo que cada técnico tenga que apagar por su cuenta.
export const SILENT_TYPES: Set<NotifType> = new Set(['n1_queue']);

// Paleta por severidad — usada para los colores de notificación (aviso/leída/no leída).
export const SEVERITY_COLOR: Record<Severity, { base: string; grad: [string, string]; tint: string }> = {
  critical: { base: '#ef4444', grad: ['#991b1b', '#dc2626'], tint: 'rgba(239,68,68,0.12)' },
  warning:  { base: '#f97316', grad: ['#b45309', '#f97316'], tint: 'rgba(249,115,22,0.12)' },
  info:     { base: '#3867E9', grad: ['#1e3a8a', '#3867E9'], tint: 'rgba(56,103,233,0.12)' },
  success:  { base: '#22c55e', grad: ['#14532d', '#16a34a'], tint: 'rgba(34,197,94,0.12)' },
};

const STORAGE_KEY = 'netsus_notifications';
const MAX_ITEMS = 60;
const DEDUPE_WINDOW_MS = 60_000;

function storageGet<T>(key: string): Promise<T | undefined> {
  return new Promise((resolve) => {
    chrome.storage.local.get([key], (r) => resolve(r[key] as T));
  });
}

function storageSet(key: string, value: unknown): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [key]: value }, () => resolve());
  });
}

export async function getAll(): Promise<AppNotification[]> {
  const raw = await storageGet<AppNotification[]>(STORAGE_KEY);
  return Array.isArray(raw) ? raw : [];
}

export interface NewNotification {
  type: NotifType;
  title: string;
  body: string;
  ticketId?: string;
  ticketNumber?: string;
  ticketUrl?: string;
  dedupeKey?: string;
  severity?: Severity; // override opcional
  icon?: IconName;     // override opcional
  silent?: boolean;    // registra sin "aviso" (toast/sonido); útil si ya hay banner propio
}

// Devuelve la notificación creada, o null si fue deduplicada (ya existía reciente).
export async function add(n: NewNotification): Promise<AppNotification | null> {
  const list = await getAll();
  const meta = TYPE_META[n.type];
  const dedupeKey = n.dedupeKey ?? `${n.type}:${n.ticketId ?? ''}`;
  const now = Date.now();

  const dupe = list.find(
    (x) => x.dedupeKey === dedupeKey && now - x.ts < DEDUPE_WINDOW_MS,
  );
  if (dupe) return null;

  const notif: AppNotification = {
    id: `${now}-${Math.random().toString(36).slice(2, 8)}`,
    type: n.type,
    severity: n.severity ?? meta.severity,
    title: n.title,
    body: n.body,
    icon: n.icon ?? meta.icon,
    ticketId: n.ticketId,
    ticketNumber: n.ticketNumber,
    ticketUrl: n.ticketUrl,
    ts: now,
    read: false,
    seen: n.silent === true, // silent ⇒ ya "visto": no dispara toast ni sonido
    dedupeKey,
  };

  const next = [notif, ...list].slice(0, MAX_ITEMS);
  await storageSet(STORAGE_KEY, next);
  return notif;
}

async function mutate(fn: (list: AppNotification[]) => AppNotification[]): Promise<void> {
  const list = await getAll();
  await storageSet(STORAGE_KEY, fn(list));
}

export async function markSeen(ids: string[]): Promise<void> {
  const set = new Set(ids);
  await mutate((list) => list.map((x) => (set.has(x.id) ? { ...x, seen: true } : x)));
}

export async function markAllSeen(): Promise<void> {
  await mutate((list) => list.map((x) => ({ ...x, seen: true })));
}

export async function markRead(id: string): Promise<void> {
  await mutate((list) => list.map((x) => (x.id === id ? { ...x, read: true, seen: true } : x)));
}

export async function markAllRead(): Promise<void> {
  await mutate((list) => list.map((x) => ({ ...x, read: true, seen: true })));
}

export async function remove(id: string): Promise<void> {
  await mutate((list) => list.filter((x) => x.id !== id));
}

export async function clearAll(): Promise<void> {
  await storageSet(STORAGE_KEY, []);
}

export function unreadCount(list: AppNotification[]): number {
  return list.filter((x) => !x.read).length;
}

// Suscripción a cambios del buzón (para mantener campana/bandeja en vivo).
export function subscribe(cb: (list: AppNotification[]) => void): () => void {
  const handler = (
    changes: { [k: string]: chrome.storage.StorageChange },
    area: string,
  ) => {
    if (area === 'local' && changes[STORAGE_KEY]) {
      cb(Array.isArray(changes[STORAGE_KEY].newValue) ? changes[STORAGE_KEY].newValue : []);
    }
  };
  chrome.storage.onChanged.addListener(handler);
  return () => chrome.storage.onChanged.removeListener(handler);
}
