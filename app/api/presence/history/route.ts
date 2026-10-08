import { NextRequest, NextResponse } from 'next/server';
import { checkApiKey } from '@/lib/ticket-lock';
import { checkAdminSession } from '@/lib/admin-auth';
import { supabase } from '@/lib/supabase/client';

// Historial de colisiones — leído desde Supabase (una fila por colisión, sin el cap de
// 200 que tenía la lista en Redis). El filtro por técnico escanea una ventana acotada
// de las más recientes y filtra en memoria, igual que hacía antes con la lista de Redis.
const SCAN_WINDOW = 1000;

export async function GET(request: NextRequest) {
  if (!checkApiKey(request)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const url = request.nextUrl;
  const offset = parseInt(url.searchParams.get('offset') ?? '0');
  const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '50'), 100);
  const tech = url.searchParams.get('tech')?.toLowerCase() ?? '';

  if (!tech) {
    const { data, count, error } = await supabase
      .from('collision_history')
      .select('id, ticket_id, ticket_number, ticket_url, users, created_at', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);
    if (error || !data) return NextResponse.json({ events: [], total: 0, offset, limit });
    const events = data.map((row) => ({
      id: row.id,
      ts: new Date(row.created_at).getTime(),
      ticketId: row.ticket_id,
      ticketNumber: row.ticket_number,
      ticketUrl: row.ticket_url,
      users: row.users ?? [],
    }));
    return NextResponse.json({ events, total: count ?? events.length, offset, limit });
  }

  const { data, error } = await supabase
    .from('collision_history')
    .select('id, ticket_id, ticket_number, ticket_url, users, created_at')
    .order('created_at', { ascending: false })
    .limit(SCAN_WINDOW);
  if (error || !data) return NextResponse.json({ events: [], total: 0, offset, limit });

  const all = data.map((row) => ({
    id: row.id,
    ts: new Date(row.created_at).getTime(),
    ticketId: row.ticket_id,
    ticketNumber: row.ticket_number,
    ticketUrl: row.ticket_url,
    users: row.users ?? [],
  }));
  const filtered = all.filter((e) => e.users.some((u: string) => u?.toLowerCase().includes(tech)));

  const total = filtered.length;
  const events = filtered.slice(offset, offset + limit);
  return NextResponse.json({ events, total, offset, limit });
}

// DELETE ?id=<uuid>       → borra una fila puntual (ej. limpiar un registro de
//                           prueba) sin tocar el resto del historial real.
// DELETE (sin parámetros) → borra TODO el historial — irreversible.
export async function DELETE(request: NextRequest) {
  if (!checkApiKey(request)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  // Acción administrativa — exige la sesión de /api/admin/auth además del
  // x-api-key (ver nota en /api/config).
  if (!(await checkAdminSession(request))) return NextResponse.json({ error: 'admin session required' }, { status: 403 });

  const id = request.nextUrl.searchParams.get('id');
  if (id) {
    await supabase.from('collision_history').delete().eq('id', id);
    return NextResponse.json({ ok: true });
  }

  await supabase.from('collision_history').delete().not('id', 'is', null);
  return NextResponse.json({ ok: true });
}
