import { NextRequest, NextResponse } from 'next/server';
import { checkApiKey } from '@/lib/ticket-lock';
import { checkAdminSession } from '@/lib/admin-auth';
import { supabase } from '@/lib/supabase/client';

export async function GET(request: NextRequest) {
  if (!checkApiKey(request)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!(await checkAdminSession(request))) return NextResponse.json({ error: 'admin session required' }, { status: 403 });

  const { data, error } = await supabase
    .from('resources')
    .select('autotask_resource_id, name, email, role, title, active')
    .order('active', { ascending: false })
    .order('name');

  if (error) return NextResponse.json({ error: 'db error' }, { status: 500 });
  return NextResponse.json({ resources: data ?? [] });
}

// Alterna manualmente active en un recurso — para sacar del roster a gente que
// Autotask sí marca isActive pero que no corresponde al equipo técnico (marketing,
// comercial, administración, etc). Además de active, marca excluded=true: eso hace
// que syncResourcesFromAutotask deje de reactivarla en cada sync. "Reactivar" en el
// panel limpia excluded y vuelve a poner active=true.
export async function PATCH(request: NextRequest) {
  if (!checkApiKey(request)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!(await checkAdminSession(request))) return NextResponse.json({ error: 'admin session required' }, { status: 403 });

  const body = await request.json().catch(() => null);
  const autotaskResourceId = body?.autotask_resource_id;
  const active = body?.active;
  if (typeof autotaskResourceId !== 'number' || typeof active !== 'boolean') {
    return NextResponse.json({ error: 'autotask_resource_id (number) y active (boolean) requeridos' }, { status: 400 });
  }

  const { error } = await supabase
    .from('resources')
    .update({ active, excluded: !active })
    .eq('autotask_resource_id', autotaskResourceId);

  if (error) return NextResponse.json({ error: 'db error' }, { status: 500 });
  return NextResponse.json({ ok: true });
}
