import { supabase } from '@/lib/supabase/client';
import { activeResources } from '@/lib/autotask';

export async function syncResourcesFromAutotask(): Promise<{ synced: number; deactivated: number }> {
  const active = await activeResources();
  if (!active.length) return { synced: 0, deactivated: 0 };

  // `role` tiene un CHECK constraint en la tabla real (resources_role_check) que el
  // title libre de Autotask viola — se fija en 'tech', el único valor que usan todas
  // las filas existentes. La columna no se lee en ninguna parte, solo se escribe.
  // `title` es distinto: sin constraint, texto libre tal cual lo trae Autotask
  // (ej. "Técnico", "Ingeniero de Soporte") — esa es la que se muestra en el panel.
  const rows = active.map((r) => ({
    autotask_resource_id: r.id,
    name: `${r.firstName} ${r.lastName}`.trim(),
    email: r.email?.trim() || null,
    role: 'tech',
    title: r.title?.trim() || null,
  }));

  // excluded = el admin sacó a esta persona del roster a mano (marketing, comercial,
  // administración, etc, que Autotask sí trae como isActive pero no es del equipo
  // técnico). El sync no debe reactivarla — solo el botón "Reactivar" del panel.
  const { data: existing, error: fetchErr } = await supabase
    .from('resources')
    .select('autotask_resource_id, active, excluded');
  if (fetchErr) throw fetchErr;

  const existingById = new Map((existing ?? []).map((r) => [r.autotask_resource_id as number, r]));
  const activeAtIds = new Set(active.map((r) => r.id));

  const toInsert = rows.filter((r) => !existingById.has(r.autotask_resource_id));
  const toUpdate = rows.filter((r) => existingById.has(r.autotask_resource_id));

  if (toInsert.length) {
    const { error } = await supabase.from('resources').insert(toInsert.map((r) => ({ ...r, active: true })));
    if (error) throw error;
  }

  for (const row of toUpdate) {
    const ex = existingById.get(row.autotask_resource_id);
    if (ex?.excluded) continue; // respeta la exclusión manual
    await supabase
      .from('resources')
      .update({ name: row.name, email: row.email, role: row.role, title: row.title, active: true })
      .eq('autotask_resource_id', row.autotask_resource_id);
  }

  // Desactiva a quien ya no viene isActive desde Autotask.
  let deactivated = 0;
  for (const ex of existing ?? []) {
    if (ex.autotask_resource_id && !activeAtIds.has(ex.autotask_resource_id) && ex.active) {
      await supabase.from('resources').update({ active: false }).eq('autotask_resource_id', ex.autotask_resource_id);
      deactivated++;
    }
  }

  return { synced: rows.length, deactivated };
}

export async function lookupResourceId(name: string): Promise<string | null> {
  const clean = name.trim();
  if (!clean) return null;
  const { data } = await supabase
    .from('resources')
    .select('id')
    .eq('active', true)
    .ilike('name', clean)
    .limit(1)
    .maybeSingle();
  return data?.id ?? null;
}

// Igual que lookupResourceId pero trae también el email — usado por /api/feedback
// para mandar el correo "de parte de" quien realmente escribió el feedback (tomado
// del roster sincronizado desde Autotask) en vez de un buzón fijo.
export async function lookupResourceIdAndEmail(name: string): Promise<{ id: string; email: string | null } | null> {
  const clean = name.trim();
  if (!clean) return null;
  const { data } = await supabase
    .from('resources')
    .select('id, email')
    .eq('active', true)
    .ilike('name', clean)
    .limit(1)
    .maybeSingle();
  return data ? { id: data.id, email: data.email } : null;
}

// Nombres de varios recursos a la vez por su autotask_resource_id — una sola query
// en vez de una por ticket (usado por el poller n1 al anunciar a quién quedó
// asignado un ticket nuevo). No dispara ninguna llamada a Autotask; si el recurso
// no está en el roster sincronizado, simplemente no aparece en el mapa devuelto.
export async function resourceNamesByIds(ids: number[]): Promise<Map<number, string>> {
  const uniqueIds = [...new Set(ids)];
  if (!uniqueIds.length) return new Map();
  const { data } = await supabase
    .from('resources')
    .select('autotask_resource_id, name')
    .in('autotask_resource_id', uniqueIds);
  const map = new Map<number, string>();
  for (const row of data ?? []) {
    if (row.autotask_resource_id !== null) map.set(row.autotask_resource_id, row.name);
  }
  return map;
}
