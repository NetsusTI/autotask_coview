import { NextRequest, NextResponse } from 'next/server';
import { checkApiKey, redis, ACTIVE_TICKETS_KEY } from '@/lib/ticket-lock';

// Ventana de gracia: el TTL de presencia configurable llega hasta 300s, así que
// cualquier ticket "vivo" hace <10 min (o el TTL configurado, lo que sea mayor)
// sigue apareciendo en el índice — un margen generoso evita descartar un ticket
// real por un score levemente desactualizado.
const INDEX_WINDOW_MS = 15 * 60 * 1000;

// La respuesta es la MISMA para todos los que la piden (la foto global de quién está
// en qué ticket), y la piden el badge, el side panel y el panel admin de CADA técnico
// varias veces por minuto. Cada cálculo cuesta 1 + 1 KEYS por ticket tocado en los
// últimos 15 min + 3 MGET — con el equipo completo eso era el mayor consumidor de la
// cuota de Redis, y crecía con el cuadrado del tamaño del equipo. Se calcula como
// mucho una vez cada 15s por instancia y todos reciben esa misma foto; los pedidos que
// llegan mientras se está calculando esperan el mismo resultado en vez de repetirlo.
// 15s de desfase es irrelevante acá: la presencia misma vive 40s.
const CACHE_MS = 15_000;
type StatusRow = { ticketId: string; ticketNumber: string | null; ticketUrl: string | null; users: { name: string; minutes: number }[] };
let cached: { at: number; data: StatusRow[] } | null = null;
let inFlight: Promise<StatusRow[]> | null = null;

export async function GET(request: NextRequest) {
  if (!checkApiKey(request)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (cached && Date.now() - cached.at < CACHE_MS) return NextResponse.json(cached.data);
  if (!inFlight) {
    inFlight = computeStatus()
      .then((data) => { cached = { at: Date.now(), data }; return data; })
      .finally(() => { inFlight = null; });
  }
  return NextResponse.json(await inFlight);
}

async function computeStatus(): Promise<StatusRow[]> {
  const now = Date.now();
  // Antes: redis.keys('ticketpresence:*') — un escaneo O(N) de TODO el keyspace
  // de Redis (no solo las keys de presencia), llamado cada 10s por cada panel
  // admin abierto. Con el índice, solo se hace KEYS acotado por ticket para los
  // tickets que efectivamente tuvieron actividad reciente.
  const ticketIds = await redis.zrange<string[]>(ACTIVE_TICKETS_KEY, now - INDEX_WINDOW_MS, '+inf', { byScore: true });
  if (!ticketIds.length) return [];

  const perTicketKeys = await Promise.all(ticketIds.map((id) => redis.keys(`ticketpresence:${id}:*`)));
  const ticketMap: Record<string, string[]> = {};
  ticketIds.forEach((id, i) => {
    const keys = perTicketKeys[i];
    if (!keys.length) return; // TTL venció pero el índice no se limpió aún (best-effort)
    ticketMap[id] = keys.map((k) => k.replace(`ticketpresence:${id}:`, ''));
  });

  const liveTicketIds = Object.keys(ticketMap);
  if (!liveTicketIds.length) return [];

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
  return liveTicketIds.map((id, i) => {
    const users = ticketMap[id].map((name) => {
      const ts = entries[entryCursor++];
      const minutes = ts ? Math.floor((Date.now() - parseInt(String(ts))) / 60000) : 0;
      return { name, minutes };
    });
    return { ticketId: id, ticketNumber: numbers[i] != null ? String(numbers[i]) : null, ticketUrl: urls[i] ?? null, users };
  });
}
