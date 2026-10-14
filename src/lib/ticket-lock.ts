import { NextRequest } from 'next/server';
import { Redis } from '@upstash/redis';

export const redis = Redis.fromEnv();

// @upstash/redis deserializa JSON automáticamente: un valor guardado como
// JSON.stringify([...]) vuelve ya como array/objeto, y hacerle JSON.parse() encima
// tira. Esto acepta las dos formas (por si algún valor quedó guardado como texto plano).
export function redisJson<T>(raw: unknown, fallback: T): T {
  if (raw === null || raw === undefined || raw === '') return fallback;
  if (typeof raw !== 'string') return raw as T;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

export function checkApiKey(request: NextRequest) {
  return request.headers.get('x-api-key') === process.env.TICKET_LOCK_API_KEY;
}

// Índice de qué tickets tienen presencia activa ahora mismo (ZSET, member=ticketId,
// score=timestamp del último POST de presencia) — usado por /api/presence/[id]
// (que lo mantiene) y /api/presence/status (que lo lee) para evitar un
// redis.keys('ticketpresence:*') sobre TODO el keyspace en cada poll.
export const ACTIVE_TICKETS_KEY = 'presence:active_tickets';
