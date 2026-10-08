// Lógica pura de filtrado/exportación del historial de colisiones — compartida por
// el panel web (app/admin/page.tsx). El panel de la extensión (ticket_lock_wxt/public/
// admin.js) tiene su propia copia en JS plano (entorno distinto, sin bundler/TS).

export interface HistoryEventLike {
  ts: number;
  ticketId: string;
  ticketNumber: string | null;
  ticketUrl?: string | null;
  users: string[];
}

export type HistoryPeriod = 'all' | 'week' | 'today' | 'custom';

export interface HistoryFilterOptions {
  period: HistoryPeriod;
  search?: string;
  dateFrom?: number | null;
  dateTo?: number | null;
  now?: number;
}

export function applyHistoryFilters(events: HistoryEventLike[], opts: HistoryFilterOptions): HistoryEventLike[] {
  const now = opts.now ?? Date.now();
  const search = (opts.search ?? '').trim().toLowerCase();
  return events.filter((e) => {
    if (opts.period === 'today' && now - e.ts > 86400000) return false;
    if (opts.period === 'week' && now - e.ts > 7 * 86400000) return false;
    if (opts.period === 'custom') {
      if (opts.dateFrom != null && e.ts < opts.dateFrom) return false;
      if (opts.dateTo != null && e.ts > opts.dateTo) return false;
    }
    if (search) {
      const haystack = `${e.ticketNumber ?? ''}${e.ticketId ?? ''}${e.users.join(' ')}`.toLowerCase();
      if (!haystack.includes(search)) return false;
    }
    return true;
  });
}

function csvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

export function buildHistoryCsv(events: HistoryEventLike[]): string {
  const rows: string[][] = [['Fecha', 'Ticket', 'Técnicos']];
  for (const e of events) {
    rows.push([
      new Date(e.ts).toLocaleString('es-CL'),
      e.ticketNumber || `#${e.ticketId}`,
      e.users.join('; '),
    ]);
  }
  return rows.map((r) => r.map(csvCell).join(',')).join('\n');
}
