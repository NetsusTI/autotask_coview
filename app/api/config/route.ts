import { NextRequest, NextResponse } from 'next/server';
import { checkApiKey, redis, redisJson } from '@/lib/ticket-lock';
import { checkAdminSession } from '@/lib/admin-auth';

export async function GET(request: NextRequest) {
  if (!checkApiKey(request)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  // Un solo MGET en vez de 9 GET. Los valores llegan ya deserializados por
  // @upstash/redis ("0"/"1" vuelven como número, JSON como objeto), de ahí los String()
  // y redisJson() — compararlos contra '0'/'1' tal cual nunca calzaba.
  const [teamsWebhook, presenceTtl, watchQueues, criticalPriorities, slaWarnMin, autotaskUiBase, notifEnabled, autotaskNotesEnabled, workHoursRaw] = await redis.mget<unknown[]>(
    'config:teams_webhook',
    'config:presence_ttl',
    'config:watch_queues',
    'config:critical_priorities',
    'config:sla_warn_min',
    'config:autotask_ui_base',
    'config:notif_enabled',
    'config:autotask_notes_enabled',
    'config:work_hours',
  );
  return NextResponse.json({
    teamsWebhook: teamsWebhook ?? '',
    presenceTtl: presenceTtl ? parseInt(String(presenceTtl)) : 40,
    watchQueues: watchQueues ?? '',
    criticalPriorities: criticalPriorities ?? '[1]',
    slaWarnMin: slaWarnMin ? parseInt(String(slaWarnMin)) : 30,
    autotaskUiBase: autotaskUiBase ?? '',
    notifEnabled: String(notifEnabled) !== '0',
    autotaskNotesEnabled: String(autotaskNotesEnabled) === '1',
    workHours: redisJson(workHoursRaw, null),
  });
}

export async function POST(request: NextRequest) {
  if (!checkApiKey(request)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  // Cambiar config (webhook de Teams, TTL, colas vigiladas, etc.) es una acción
  // administrativa — exige la sesión de /api/admin/auth además del x-api-key, que
  // por sí solo no alcanza (viene embebido en la extensión pública).
  if (!(await checkAdminSession(request))) return NextResponse.json({ error: 'admin session required' }, { status: 403 });
  const body = await request.json().catch(() => ({}));
  const ops: Promise<unknown>[] = [];
  if ('teamsWebhook' in body) {
    ops.push(body.teamsWebhook
      ? redis.set('config:teams_webhook', body.teamsWebhook)
      : redis.del('config:teams_webhook'));
  }
  if ('presenceTtl' in body) {
    const ttl = Math.max(15, Math.min(300, parseInt(body.presenceTtl) || 40));
    ops.push(redis.set('config:presence_ttl', String(ttl)));
  }

  // Normaliza "1,2,3" o [1,2,3] a un array JSON de números.
  const toNumArray = (v: unknown): number[] => {
    const arr = Array.isArray(v) ? v : String(v ?? '').split(',');
    return arr.map((x) => parseInt(String(x).trim())).filter((n) => !Number.isNaN(n));
  };
  if ('watchQueues' in body) {
    ops.push(redis.set('config:watch_queues', JSON.stringify(toNumArray(body.watchQueues))));
  }
  if ('criticalPriorities' in body) {
    const nums = toNumArray(body.criticalPriorities);
    ops.push(redis.set('config:critical_priorities', JSON.stringify(nums.length ? nums : [1])));
  }
  if ('slaWarnMin' in body) {
    const m = Math.max(5, Math.min(1440, parseInt(body.slaWarnMin) || 30));
    ops.push(redis.set('config:sla_warn_min', String(m)));
  }
  if ('autotaskUiBase' in body) {
    const base = String(body.autotaskUiBase ?? '').trim();
    ops.push(base ? redis.set('config:autotask_ui_base', base) : redis.del('config:autotask_ui_base'));
  }
  if ('notifEnabled' in body) {
    ops.push(redis.set('config:notif_enabled', body.notifEnabled ? '1' : '0'));
  }
  if ('autotaskNotesEnabled' in body) {
    ops.push(redis.set('config:autotask_notes_enabled', body.autotaskNotesEnabled ? '1' : '0'));
  }
  if ('workHours' in body) {
    if (!body.workHours) {
      ops.push(redis.del('config:work_hours'));
    } else {
      const wh = {
        start: Math.max(0, Math.min(23, parseInt(body.workHours.start) || 8)),
        end: Math.max(0, Math.min(23, parseInt(body.workHours.end) || 18)),
        tz: String(body.workHours.tz || 'America/Santiago'),
        enabled: !!body.workHours.enabled,
      };
      ops.push(redis.set('config:work_hours', JSON.stringify(wh)));
    }
  }

  await Promise.all(ops);
  return NextResponse.json({ ok: true });
}
