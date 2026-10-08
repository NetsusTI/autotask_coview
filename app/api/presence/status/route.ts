import { NextRequest, NextResponse } from 'next/server';
import { checkApiKey, redis, ACTIVE_TICKETS_KEY } from '@/lib/ticket-lock';

// Ventana de gracia: el TTL de presencia configurable llega hasta 300s, así que
// cualquier ticket "vivo" hace <10 min (o el TTL configurado, lo que sea mayor)
// sigue apareciendo en el índice — un margen generoso evita descartar un ticket
// real por un score levemente desactualizado.
const INDEX_WINDOW_MS = 15 * 60 * 1000;

export async function GET(request: NextRequest) {
  if (!checkApiKey(request)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const now = Date.now();
  // Antes: redis.keys('ticketpresence:*') — un escaneo O(N) de TODO el keyspace
  // de Redis (no solo las keys de presencia), llamado cada 10s por cada panel
  // admin abierto. Con el índice, solo se hace KEYS acotado por ticket para los
  // tickets que efectivamente tuvieron actividad reciente.
  const ticketIds = await redis.zrange<string[]>(ACTIVE_TICKETS_KEY, now - INDEX_WINDOW_MS, '+inf', { byScore: true });
  if (!ticketIds.length) return NextResponse.json([]);

  const perTicketKeys = await Promise.all(ticketIds.map((id) => redis.keys(`ticketpresence:${id}:*`)));
  const ticketMap: Record<string, string[]> = {};
  ticketIds.forEach((id, i) => {
    const keys = perTicketKeys[i];
    if (!keys.length) return; // TTL venció pero el índice no se limpió aún (best-effort)
    ticketMap[id] = keys.map((k) => k.replace(`ticketpresence:${id}:`, ''));
  });

  const liveTicketIds = Object.keys(ticketMap);
  if (!liveTicketIds.length) return NextResponse.json([]);

  // mget en vez de un GET por ticket/usuario (antes: Promise.all de redis.get
  // individuales) — mismo resultado, pero son 3 comandos Redis en total para todo
  // el panel en vez de 2 + 1 por técnico por ticket. Este endpoint lo pollean el
  // panel admin, el side panel y el background de cada técnico cada 10-20s, así
  // que el ahorro escala con el tamaño del equipo.
  const entryKeys = liveTicketIds.flatMap((id) => ticketMap[id].map((name) => `ticketentry:${id}:${name}`));
  const [numbers, urls, entries] = await Promise.all([
    redis.mget<(string | null)[]>(...liveTicketIds.map((id) => `ticketnumber:${id}`)),
    redis.mget<(string | null)[]>(...liveTicketIds.map((id) => `ticketurl:${id}`)),
    entryKeys.length ? redis.mget<(string | null)[]>(...entryKeys) : Promise.resolve([]),
  ]);

  let entryCursor = 0;
  const result = liveTicketIds.map((id, i) => {
    const users = ticketMap[id].map((name) => {
      const ts = entries[entryCursor++];
      const minutes = ts ? Math.floor((Date.now() - parseInt(ts)) / 60000) : 0;
      return { name, minutes };
    });
    return { ticketId: id, ticketNumber: numbers[i] ?? null, ticketUrl: urls[i] ?? null, users };
  });

  return NextResponse.json(result);
}
