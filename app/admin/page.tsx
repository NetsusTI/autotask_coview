'use client';

import { useEffect, useState } from 'react';
import { Montserrat } from 'next/font/google';
import { Icon } from '@/lib/icons';
import { applyHistoryFilters, buildHistoryCsv, type HistoryPeriod } from '@/lib/history-filter';

const montserrat = Montserrat({ subsets: ['latin'], weight: ['300', '400', '600', '800'] });

interface TicketPresence {
  ticketId: string;
  ticketNumber: string | null;
  ticketUrl?: string | null;
  users: string[];
}

interface CollisionEvent {
  ts: number;
  ticketId: string;
  ticketNumber: string | null;
  ticketUrl?: string | null;
  users: string[];
}

interface NotifLogEntry {
  type: string;
  title: string;
  body: string;
  ticketId?: string;
  ticketNumber?: string;
  ticketUrl?: string;
  targets?: string[];
  ts: number;
}

interface FeedbackItem {
  id: string;
  resource_name: string;
  type: string;
  message: string;
  created_at: string;
}

interface AnalyticsData {
  byTech: { name: string; count: number; pct: number }[];
  byHour: number[];
  byDay: { date: string; count: number }[];
  topTickets: { ticket: string; count: number }[];
  pairs: { pair: string; count: number }[];
  total: number;
  avgDurationSecs: number | null;
  maxDurationSecs: number | null;
  resolvedCount: number;
}

const HISTORY_PAGE = 50;

const FEEDBACK_META: Record<string, { label: string; color: string }> = {
  mejorar: { label: 'Mejorar', color: '#3867E9' },
  agregar: { label: 'Agregar', color: '#22c55e' },
  quitar:  { label: 'Quitar', color: '#f97316' },
  otro:    { label: 'Otro', color: '#8C52FF' },
};

const NOTIF_META: Record<string, { icon: Parameters<typeof Icon>[0]['name']; color: string; tint: string }> = {
  collision:   { icon: 'alert-triangle', color: '#ef4444', tint: 'rgba(239,68,68,0.12)' },
  ping:        { icon: 'megaphone',      color: '#f97316', tint: 'rgba(249,115,22,0.12)' },
  liberation:  { icon: 'check-circle',   color: '#22c55e', tint: 'rgba(34,197,94,0.12)' },
  n1_queue:    { icon: 'inbox',          color: '#3867E9', tint: 'rgba(56,103,233,0.12)' },
  n2_assign:   { icon: 'user-plus',      color: '#f97316', tint: 'rgba(249,115,22,0.12)' },
  n3_client:   { icon: 'message-square', color: '#f97316', tint: 'rgba(249,115,22,0.12)' },
  n4_sla:      { icon: 'timer',          color: '#ef4444', tint: 'rgba(239,68,68,0.12)' },
  n5_critical: { icon: 'flame',          color: '#ef4444', tint: 'rgba(239,68,68,0.12)' },
};
const NOTIF_META_DEFAULT = { icon: 'bell' as const, color: '#3867E9', tint: 'rgba(56,103,233,0.12)' };

function relTime(ts: number): string {
  const secs = Math.floor((Date.now() - ts) / 1000);
  if (secs < 60) return 'ahora';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `hace ${mins} min`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `hace ${hrs} h`;
  return `hace ${Math.floor(hrs / 24)} d`;
}

const API_KEY = '-_-ErJy9v64XRiDbpuPFZ3uLs4nVFmXm';

type ThemePref = 'auto' | 'light' | 'dark';
type ResolvedTheme = 'light' | 'dark';
const THEME_STORAGE_KEY = 'netsus_admin_theme';

const PALETTE: Record<ResolvedTheme, Record<string, string>> = {
  dark: {
    pageBg: 'linear-gradient(135deg, #190637 0%, #0d0320 100%)',
    text: '#fff',
    cardBg: 'rgba(255,255,255,0.04)',
    cardBorder: 'rgba(255,255,255,0.08)',
    accentBorder: 'rgba(239,68,68,0.35)',
    dim: 'rgba(255,255,255,0.4)',
    faint: 'rgba(255,255,255,0.25)',
    headerBg: 'rgba(255,255,255,0.03)',
    headerBorder: 'rgba(255,255,255,0.07)',
    chipBg: 'rgba(255,255,255,0.1)',
    chipBg2: 'rgba(255,255,255,0.06)',
    inputBg: 'rgba(255,255,255,0.06)',
    inputBorder: 'rgba(255,255,255,0.12)',
    dashedBorder: 'rgba(255,255,255,0.1)',
    emptyBg: 'rgba(255,255,255,0.02)',
    iconBg: 'rgba(255,255,255,0.06)',
  },
  light: {
    pageBg: 'linear-gradient(135deg, #F3F3F3 0%, #e7e7ec 100%)',
    text: '#3B3B3B',
    cardBg: '#ffffff',
    cardBorder: 'rgba(59,59,59,0.1)',
    accentBorder: 'rgba(239,68,68,0.35)',
    dim: 'rgba(59,59,59,0.97)',
    faint: 'rgba(59,59,59,0.85)',
    headerBg: 'rgba(255,255,255,0.75)',
    headerBorder: 'rgba(59,59,59,0.08)',
    chipBg: 'rgba(59,59,59,0.08)',
    chipBg2: 'rgba(59,59,59,0.05)',
    inputBg: 'rgba(59,59,59,0.04)',
    inputBorder: 'rgba(59,59,59,0.15)',
    dashedBorder: 'rgba(59,59,59,0.15)',
    emptyBg: 'rgba(59,59,59,0.02)',
    iconBg: 'rgba(59,59,59,0.05)',
  },
};

const ACCENT = '#3867E9';

function resolveTheme(pref: ThemePref): ResolvedTheme {
  if (pref === 'light' || pref === 'dark') return pref;
  if (typeof matchMedia === 'undefined') return 'dark';
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function ThemeToggle({ pref, onChange }: { pref: ThemePref; onChange: (p: ThemePref) => void }) {
  const opts: { v: ThemePref; label: React.ReactNode }[] = [
    { v: 'auto', label: 'Auto' },
    { v: 'light', label: <Icon name="sun" size={13} /> },
    { v: 'dark', label: <Icon name="moon" size={13} /> },
  ];
  return (
    <div style={{ display: 'inline-flex', background: 'rgba(128,128,128,0.15)', borderRadius: 8, padding: 2, gap: 2 }}>
      {opts.map(o => (
        <button
          key={o.v}
          onClick={() => onChange(o.v)}
          style={{
            border: 'none', borderRadius: 6, padding: '4px 10px', fontSize: 11, cursor: 'pointer',
            display: 'flex', alignItems: 'center',
            background: pref === o.v ? ACCENT : 'transparent',
            color: pref === o.v ? '#fff' : 'inherit', fontWeight: pref === o.v ? 600 : 400,
          }}
        >{o.label}</button>
      ))}
    </div>
  );
}

const FOOTER_HEIGHT = 44;

function Footer({ color, background, border }: { color: string; background: string; border: string }) {
  return (
    <div style={{
      position: 'fixed', bottom: 0, left: 0, right: 0, height: FOOTER_HEIGHT, zIndex: 20,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      textAlign: 'center', fontSize: 11, color,
      background, borderTop: `1px solid ${border}`, backdropFilter: 'blur(10px)',
    }}>
      <b style={{ color: ACCENT, fontWeight: 800 }}>netsus</b>&nbsp;· Innovación Tecnológica
    </div>
  );
}

export default function AdminPage() {
  const [auth, setAuth] = useState(false);
  const [pwd, setPwd] = useState('');
  const [pwdError, setPwdError] = useState(false);
  const [tickets, setTickets] = useState<TicketPresence[]>([]);
  const [history, setHistory] = useState<CollisionEvent[]>([]);
  const [lastUpdate, setLastUpdate] = useState<Date>(new Date());
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<'live' | 'history' | 'analytics' | 'resources' | 'notifications' | 'feedback' | 'config'>('live');
  const [online, setOnline] = useState(0);
  const [teamConfigured, setTeamConfigured] = useState(false);
  const [notifLog, setNotifLog] = useState<NotifLogEntry[]>([]);
  const [notifTotal, setNotifTotal] = useState(0);
  const [notifLoadingMore, setNotifLoadingMore] = useState(false);
  const [feedbackItems, setFeedbackItems] = useState<FeedbackItem[]>([]);
  const [feedbackTotal, setFeedbackTotal] = useState(0);
  const [feedbackLoadingMore, setFeedbackLoadingMore] = useState(false);

  const [notifEnabled, setNotifEnabled] = useState(true);
  const [watchQueues, setWatchQueues] = useState('');
  const [criticalPriorities, setCriticalPriorities] = useState('1');
  const [slaWarnMin, setSlaWarnMin] = useState(30);
  const [autotaskUiBase, setAutotaskUiBase] = useState('');
  const [autotaskNotesEnabled, setAutotaskNotesEnabled] = useState(false);
  const [configStatus, setConfigStatus] = useState('');
  const [pollStatus, setPollStatus] = useState('');
  const [pollLoading, setPollLoading] = useState(false);

  const [analytics, setAnalytics] = useState<AnalyticsData | null>(null);
  const [analyticsLoading, setAnalyticsLoading] = useState(false);

  const [historyFilter, setHistoryFilter] = useState('');
  const [historyPeriod, setHistoryPeriod] = useState<HistoryPeriod>('all');
  const [historyTechFilter, setHistoryTechFilter] = useState('');
  const [dateFrom, setDateFrom] = useState<number | null>(null);
  const [dateTo, setDateTo] = useState<number | null>(null);
  const [historyOffset, setHistoryOffset] = useState(0);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [historyLoadingMore, setHistoryLoadingMore] = useState(false);

  const [syncStatus, setSyncStatus] = useState('');
  const [syncLoading, setSyncLoading] = useState(false);

  const [currentPwd, setCurrentPwd] = useState('');
  const [newPwd, setNewPwd] = useState('');
  const [pwdChangeStatus, setPwdChangeStatus] = useState('');

  const [themePref, setThemePref] = useState<ThemePref>('auto');
  const [resolved, setResolved] = useState<ResolvedTheme>('dark');

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- lectura de sessionStorage una sola vez al montar, no hay forma de leerla fuera de un efecto (API solo-cliente)
    if (sessionStorage.getItem('netsus_admin') === '1') setAuth(true);
    const stored = localStorage.getItem(THEME_STORAGE_KEY) as ThemePref | null;
    const pref = stored === 'light' || stored === 'dark' ? stored : 'auto';
    setThemePref(pref);
    setResolved(resolveTheme(pref));
  }, []);

  useEffect(() => {
    if (typeof matchMedia === 'undefined') return;
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const handler = () => { if (themePref === 'auto') setResolved(resolveTheme('auto')); };
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [themePref]);

  function changeTheme(p: ThemePref) {
    setThemePref(p);
    setResolved(resolveTheme(p));
    localStorage.setItem(THEME_STORAGE_KEY, p);
  }

  async function login() {
    try {
      const res = await fetch('/api/admin/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pwd }),
      });
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        sessionStorage.setItem('netsus_admin', '1');
        if (data.token) sessionStorage.setItem('netsus_admin_token', data.token);
        setAuth(true);
        return;
      }
    } catch {
      // cae al bloque de error de abajo
    }
    setPwdError(true);
    setTimeout(() => setPwdError(false), 2000);
  }

  // Token de sesión de admin (emitido por /api/admin/auth) — exigido además del
  // x-api-key en endpoints administrativos (/api/config POST, etc.), ya que el
  // x-api-key por sí solo viene embebido en la extensión pública.
  function adminHeaders(extra?: Record<string, string>) {
    return { ...extra, 'x-api-key': API_KEY, 'x-admin-token': sessionStorage.getItem('netsus_admin_token') || '' };
  }

  async function fetchData() {
    try {
      const [presRes, onlineRes, notifRes, feedbackRes] = await Promise.all([
        fetch('/api/presence/status', { headers: { 'x-api-key': API_KEY } }),
        fetch('/api/team/online', { headers: { 'x-api-key': API_KEY } }),
        fetch('/api/notifications/log?offset=0&limit=50', { headers: { 'x-api-key': API_KEY } }),
        fetch('/api/feedback?offset=0&limit=50', { headers: { 'x-api-key': API_KEY } }),
      ]);
      const presence: TicketPresence[] = await presRes.json().catch(() => []);
      const onlineData = await onlineRes.json().catch(() => ({ online: 0, configured: false }));
      const notifData = await notifRes.json().catch(() => ({ events: [], total: 0 }));
      const feedbackData = await feedbackRes.json().catch(() => ({ items: [], total: 0 }));
      setTickets(Array.isArray(presence) ? presence : []);
      setOnline(onlineData.online ?? 0);
      setTeamConfigured(!!onlineData.configured);
      setNotifLog(Array.isArray(notifData.events) ? notifData.events : []);
      setNotifTotal(notifData.total ?? 0);
      setFeedbackItems(Array.isArray(feedbackData.items) ? feedbackData.items : []);
      setFeedbackTotal(feedbackData.total ?? 0);
      setLastUpdate(new Date());
    } finally {
      setLoading(false);
    }
  }

  async function fetchHistory(append: boolean) {
    try {
      const offset = append ? historyOffset : 0;
      const techParam = historyTechFilter ? `&tech=${encodeURIComponent(historyTechFilter)}` : '';
      const res = await fetch(`/api/presence/history?offset=${offset}&limit=${HISTORY_PAGE}${techParam}`, { headers: { 'x-api-key': API_KEY } });
      const data = await res.json().catch(() => ({ events: [], total: 0 }));
      const events: CollisionEvent[] = Array.isArray(data.events) ? data.events : [];
      setHistoryTotal(data.total ?? events.length);
      if (append) {
        setHistory(prev => [...prev, ...events]);
        setHistoryOffset(prev => prev + events.length);
      } else {
        setHistory(events);
        setHistoryOffset(events.length);
      }
    } finally {
      if (append) setHistoryLoadingMore(false);
    }
  }

  // Wrapper solo para el botón "Cargar más" — el flag de loading no debe fijarse
  // sincrónicamente dentro de fetchHistory (dispararía set-state-in-effect en el
  // useEffect que llama fetchHistory(false) para la carga inicial/por filtro).
  function loadMoreHistory() {
    setHistoryLoadingMore(true);
    fetchHistory(true);
  }

  async function loadAnalytics() {
    setAnalyticsLoading(true);
    try {
      const res = await fetch('/api/presence/analytics', { headers: { 'x-api-key': API_KEY } });
      const data = await res.json().catch(() => null);
      setAnalytics(data);
    } finally {
      setAnalyticsLoading(false);
    }
  }

  function selectTab(t: typeof tab) {
    setTab(t);
    if (t === 'analytics') loadAnalytics();
  }

  function exportHistoryCsv() {
    const filtered = applyHistoryFilters(history, { period: historyPeriod, search: historyFilter, dateFrom, dateTo });
    if (!filtered.length) return;
    const csv = buildHistoryCsv(filtered);
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `colisiones_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  async function syncResources() {
    setSyncLoading(true);
    setSyncStatus('Sincronizando con Autotask...');
    try {
      const res = await fetch('/api/resources/sync', { method: 'POST', headers: adminHeaders() });
      if (res.status === 403) { setSyncStatus('✗ Sesión expirada, vuelve a ingresar'); return; }
      const data = await res.json().catch(() => ({}));
      setSyncStatus(!data.ran
        ? '⚠ No se ejecutó (Autotask sin credenciales o error de Supabase)'
        : `✓ Roster actualizado · ${data.synced} activos${data.deactivated ? `, ${data.deactivated} desactivados` : ''}`);
    } catch {
      setSyncStatus('✗ Error al sincronizar');
    } finally {
      setSyncLoading(false);
      setTimeout(() => setSyncStatus(''), 6000);
    }
  }

  async function changeAdminPassword() {
    if (!currentPwd || !newPwd) { setPwdChangeStatus('Completa ambos campos'); return; }
    try {
      const res = await fetch('/api/admin/change-password', {
        method: 'POST',
        headers: adminHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ currentPassword: currentPwd, newPassword: newPwd }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setPwdChangeStatus(
          res.status === 403 && data.error !== 'wrong_password' ? '✗ Sesión expirada, vuelve a ingresar'
            : data.error === 'wrong_password' ? '✗ Contraseña actual incorrecta'
            : '✗ Error al cambiar la contraseña'
        );
      } else {
        setCurrentPwd('');
        setNewPwd('');
        setPwdChangeStatus(data.envOverride
          ? '✓ Guardada, pero ADMIN_PASSWORD sigue seteada en Vercel — no tendrá efecto hasta que la borres'
          : '✓ Contraseña actualizada');
      }
    } catch {
      setPwdChangeStatus('✗ Error de conexión');
    }
    setTimeout(() => setPwdChangeStatus(''), 6000);
  }

  async function loadMoreNotifs() {
    setNotifLoadingMore(true);
    try {
      const res = await fetch(`/api/notifications/log?offset=${notifLog.length}&limit=50`, { headers: { 'x-api-key': API_KEY } });
      const data = await res.json().catch(() => ({ events: [], total: notifTotal }));
      setNotifLog(prev => [...prev, ...(Array.isArray(data.events) ? data.events : [])]);
      setNotifTotal(data.total ?? notifTotal);
    } finally {
      setNotifLoadingMore(false);
    }
  }

  async function loadMoreFeedback() {
    setFeedbackLoadingMore(true);
    try {
      const res = await fetch(`/api/feedback?offset=${feedbackItems.length}&limit=50`, { headers: { 'x-api-key': API_KEY } });
      const data = await res.json().catch(() => ({ items: [], total: feedbackTotal }));
      setFeedbackItems(prev => [...prev, ...(Array.isArray(data.items) ? data.items : [])]);
      setFeedbackTotal(data.total ?? feedbackTotal);
    } finally {
      setFeedbackLoadingMore(false);
    }
  }

  useEffect(() => {
    if (!auth) return;
    fetchData();
    const interval = setInterval(fetchData, 10000);
    return () => clearInterval(interval);
  }, [auth]);

  useEffect(() => {
    if (!auth) return;
    fetchHistory(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetchHistory reads historyTechFilter directly, listado como dep
  }, [auth, historyTechFilter]);

  useEffect(() => {
    if (!auth) return;
    fetch('/api/config', { headers: { 'x-api-key': API_KEY } })
      .then(res => res.json())
      .then(data => {
        setNotifEnabled(data.notifEnabled !== false);
        try { setWatchQueues((JSON.parse(data.watchQueues || '[]') as number[]).join(', ')); } catch { setWatchQueues(''); }
        try { setCriticalPriorities((JSON.parse(data.criticalPriorities || '[1]') as number[]).join(', ')); } catch { setCriticalPriorities('1'); }
        setSlaWarnMin(data.slaWarnMin || 30);
        setAutotaskUiBase(data.autotaskUiBase || '');
        setAutotaskNotesEnabled(!!data.autotaskNotesEnabled);
      })
      .catch(() => {});
  }, [auth]);

  async function saveNotifConfig() {
    setConfigStatus('saving');
    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: adminHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ notifEnabled, watchQueues, criticalPriorities, slaWarnMin, autotaskUiBase: autotaskUiBase.trim(), autotaskNotesEnabled }),
      });
      setConfigStatus(res.ok ? '✓ Configuración guardada' : (res.status === 403 ? '✗ Sesión expirada, vuelve a ingresar' : '✗ Error al guardar'));
    } catch {
      setConfigStatus('✗ Error al guardar');
    }
    setTimeout(() => setConfigStatus(''), 3000);
  }

  async function pollNow() {
    setPollLoading(true);
    setPollStatus('Sondeando Autotask...');
    try {
      const res = await fetch('/api/notifications/poll?force=1', { headers: { 'x-api-key': API_KEY } });
      const data = await res.json();
      if (!data.ran) {
        setPollStatus('⚠ No se ejecutó (poller desactivado o Autotask sin credenciales)');
      } else {
        const c = data.counts || {};
        setPollStatus(`✓ Sondeo OK · n1:${c.n1 || 0} n2:${c.n2 || 0} n3:${c.n3 || 0} n4:${c.n4 || 0} n5:${c.n5 || 0}`);
      }
    } catch {
      setPollStatus('✗ Error de conexión');
    }
    setPollLoading(false);
  }

  const p = PALETTE[resolved];

  if (!auth) {
    return (
      <div className={montserrat.className} style={{
        minHeight: '100vh', display: 'flex', flexDirection: 'column',
        background: p.pageBg, color: p.text, fontWeight: 400, position: 'relative',
      }}>
        <div style={{ position: 'absolute', top: 20, right: 20 }}>
          <ThemeToggle pref={themePref} onChange={changeTheme} />
        </div>
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{
            background: p.cardBg, border: `1px solid ${p.cardBorder}`,
            borderRadius: 20, padding: '40px 36px', width: 320, textAlign: 'center',
          }}>
            <img src="/netsus-logo.png" alt="netsus" style={{ height: 28, margin: '0 auto 24px', display: 'block' }} />
            <div style={{ fontSize: 16, fontWeight: 800, color: p.text, marginBottom: 4 }}>Panel de Administración</div>
            <div style={{ fontSize: 12, color: p.dim, marginBottom: 28 }}>Autotask CoView · Netsus</div>
            <input
              type="password"
              placeholder="Contraseña"
              value={pwd}
              onChange={e => setPwd(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && login()}
              style={{
                width: '100%', padding: '10px 14px', borderRadius: 10, fontSize: 14, fontFamily: 'inherit',
                background: p.inputBg,
                border: `1px solid ${pwdError ? '#ef4444' : p.inputBorder}`,
                color: p.text, boxSizing: 'border-box', outline: 'none', marginBottom: 12,
              }}
            />
            {pwdError && <div style={{ fontSize: 12, color: '#ef4444', marginBottom: 10 }}>Contraseña incorrecta</div>}
            <button onClick={login} style={{
              width: '100%', padding: '10px', borderRadius: 10, fontSize: 14, fontWeight: 600, fontFamily: 'inherit',
              background: ACCENT, color: '#fff',
              border: 'none', cursor: 'pointer',
            }}>Ingresar</button>
          </div>
        </div>
        <Footer color={p.faint} background={p.headerBg} border={p.headerBorder} />
        <style>{`input::placeholder { color: ${p.faint}; }`}</style>
      </div>
    );
  }

  const busyTechs = new Set(tickets.flatMap(t => t.users)).size;
  const available = teamConfigured ? Math.max(0, online - busyTechs) : null;
  const collisionsToday = history.filter(e => lastUpdate.getTime() - e.ts < 86400000).length;

  return (
    <div className={montserrat.className} style={{
      minHeight: '100vh', display: 'flex', flexDirection: 'column',
      background: p.pageBg, color: p.text, fontWeight: 400,
    }}>
      {/* Header */}
      <div style={{
        borderBottom: `1px solid ${p.headerBorder}`, padding: '0 40px',
        background: p.headerBg, backdropFilter: 'blur(10px)',
        position: 'sticky', top: 0, zIndex: 10,
      }}>
        <div style={{ maxWidth: 900, margin: '0 auto', display: 'flex', alignItems: 'center', justifyContent: 'space-between', height: 64 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <img src="/netsus-logo.png" alt="netsus" style={{ height: 22 }} />
            <div style={{ width: 1, height: 28, background: p.headerBorder }} />
            <div>
              <div style={{ fontSize: 15, fontWeight: 800 }}>Autotask CoView</div>
              <div style={{ fontSize: 11, color: p.dim, marginTop: -2 }}>Netsus · Panel de control</div>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: p.dim }}>
              <div style={{ width: 7, height: 7, borderRadius: '50%', background: '#22c55e', boxShadow: '0 0 6px #22c55e', animation: 'pulse 2s infinite' }} />
              En vivo · {lastUpdate.toLocaleTimeString('es-CL')}
            </div>
            <ThemeToggle pref={themePref} onChange={changeTheme} />
          </div>
        </div>
      </div>

      <div style={{ maxWidth: 900, margin: '0 auto', padding: `40px 40px ${FOOTER_HEIGHT + 24}px`, width: '100%', boxSizing: 'border-box', flex: 1 }}>

        {/* Stats */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 16, marginBottom: 32 }}>
          {[
            { label: 'Tickets activos', value: String(tickets.length), icon: 'ticket' as const, color: ACCENT },
            { label: 'Técnicos ocupados', value: String(busyTechs), icon: 'users' as const, color: ACCENT },
            {
              label: teamConfigured ? 'Técnicos disponibles' : 'Disponibles (requiere n1–n5)',
              value: available === null ? '—' : String(available),
              icon: 'user' as const, color: '#22c55e',
            },
            { label: 'Colisiones hoy', value: String(collisionsToday), icon: 'alert-triangle' as const, color: '#ef4444' },
          ].map(({ label, value, icon, color }) => (
            <div key={label} style={{
              background: p.cardBg, border: `1px solid ${p.cardBorder}`,
              borderRadius: 16, padding: '20px 24px',
            }}>
              <div style={{ marginBottom: 8, color }}><Icon name={icon} size={22} /></div>
              <div style={{ fontSize: 28, fontWeight: 800, color }}>{value}</div>
              <div style={{ fontSize: 12, fontWeight: 600, color: p.dim, marginTop: 2 }}>{label}</div>
            </div>
          ))}
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 20, flexWrap: 'wrap' }}>
          {(['live', 'history', 'analytics', 'resources', 'notifications', 'feedback', 'config'] as const).map(t => (
            <button key={t} onClick={() => selectTab(t)} style={{
              padding: '6px 18px', borderRadius: 20, fontSize: 13, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer', border: 'none',
              display: 'flex', alignItems: 'center', gap: 6,
              background: tab === t ? ACCENT : p.chipBg2,
              color: tab === t ? '#fff' : p.text,
            }}>
              <Icon name={
                t === 'live' ? 'circle' : t === 'history' ? 'clipboard-list' : t === 'analytics' ? 'bar-chart-3'
                  : t === 'resources' ? 'users' : t === 'notifications' ? 'bell' : t === 'feedback' ? 'message-square' : 'settings'
              } size={13} />
              {t === 'live' ? 'En vivo' : t === 'history' ? 'Historial' : t === 'analytics' ? 'Análisis' : t === 'resources' ? 'Recursos'
                : t === 'notifications' ? 'Centro de Notificaciones' : t === 'feedback' ? 'Feedback' : 'Config'}
            </button>
          ))}
        </div>
        {tab === 'history' && (
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 16 }}>
            <input
              value={historyFilter} onChange={e => setHistoryFilter(e.target.value)}
              placeholder="Filtrar por técnico o ticket..."
              style={{
                flex: 1, minWidth: 160, padding: '8px 12px', borderRadius: 10, fontSize: 13, fontFamily: 'inherit',
                background: p.inputBg, border: `1px solid ${p.inputBorder}`, color: p.text, outline: 'none',
              }}
            />
            <select
              value={historyTechFilter} onChange={e => setHistoryTechFilter(e.target.value)}
              style={{
                maxWidth: 180, padding: '8px 12px', borderRadius: 10, fontSize: 13, fontFamily: 'inherit',
                background: p.inputBg, border: `1px solid ${p.inputBorder}`, color: p.text, outline: 'none',
              }}
            >
              <option value="">Todos los técnicos</option>
              {Array.from(new Set(history.flatMap(e => e.users))).sort().map(name => (
                <option key={name} value={name}>{name}</option>
              ))}
            </select>
            <div style={{ display: 'flex', gap: 4 }}>
              {([['all', 'Todo'], ['week', 'Semana'], ['today', 'Hoy'], ['custom', 'Rango']] as const).map(([v, label]) => (
                <button key={v} onClick={() => setHistoryPeriod(v)} style={{
                  padding: '5px 12px', borderRadius: 16, fontSize: 11, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer',
                  border: `1px solid ${historyPeriod === v ? 'rgba(56,103,233,0.4)' : p.inputBorder}`,
                  background: historyPeriod === v ? 'rgba(56,103,233,0.18)' : 'transparent',
                  color: historyPeriod === v ? ACCENT : p.dim,
                }}>{label}</button>
              ))}
            </div>
            {historyPeriod === 'custom' && (
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input type="date" onChange={e => setDateFrom(e.target.value ? new Date(e.target.value).getTime() : null)} style={{
                  width: 130, padding: '5px 8px', borderRadius: 10, fontSize: 13, fontFamily: 'inherit',
                  background: p.inputBg, border: `1px solid ${p.inputBorder}`, color: p.text, outline: 'none',
                }} />
                <span style={{ color: p.faint, fontSize: 12 }}>→</span>
                <input type="date" onChange={e => setDateTo(e.target.value ? new Date(e.target.value + 'T23:59:59').getTime() : null)} style={{
                  width: 130, padding: '5px 8px', borderRadius: 10, fontSize: 13, fontFamily: 'inherit',
                  background: p.inputBg, border: `1px solid ${p.inputBorder}`, color: p.text, outline: 'none',
                }} />
              </div>
            )}
            <button onClick={exportHistoryCsv} style={{
              marginLeft: 'auto', padding: '6px 14px', borderRadius: 20, fontSize: 12, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer',
              border: `1px solid ${p.inputBorder}`, background: p.chipBg2, color: p.dim,
              display: 'inline-flex', alignItems: 'center', gap: 5,
            }}><Icon name="clipboard-list" size={13} /> Exportar CSV</button>
          </div>
        )}

        {tab === 'live' ? (
          loading ? (
            <div style={{ textAlign: 'center', padding: '80px 0', color: p.faint, fontSize: 14 }}>Cargando...</div>
          ) : tickets.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '80px 0', background: p.emptyBg, border: `1px dashed ${p.dashedBorder}`, borderRadius: 20 }}>
              <div style={{ marginBottom: 12, color: '#22c55e', display: 'flex', justifyContent: 'center' }}><Icon name="check-circle" size={40} /></div>
              <div style={{ fontSize: 15, color: p.dim }}>Sin colisiones activas</div>
              <div style={{ fontSize: 12, color: p.faint, marginTop: 4 }}>Todos los técnicos trabajan sin conflictos</div>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {tickets.map(({ ticketId, ticketNumber, ticketUrl, users }) => (
                <div
                  key={ticketId}
                  onClick={() => { if (ticketUrl) window.open(ticketUrl, '_blank', 'noopener,noreferrer'); }}
                  title={ticketUrl ? 'Abrir ticket en Autotask' : undefined}
                  style={{
                    background: p.cardBg,
                    border: `1px solid ${users.length > 1 ? p.accentBorder : p.cardBorder}`,
                    borderRadius: 16, padding: '18px 24px',
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    cursor: ticketUrl ? 'pointer' : 'default',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                    <div style={{
                      width: 42, height: 42, borderRadius: 12,
                      background: users.length > 1 ? 'rgba(239,68,68,0.15)' : p.iconBg,
                      color: users.length > 1 ? '#ef4444' : ACCENT,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}>
                      <Icon name={users.length > 1 ? 'alert-triangle' : 'ticket'} size={18} />
                    </div>
                    <div>
                      <div style={{ fontSize: 14, fontWeight: 600 }}>{ticketNumber ?? `#${ticketId}`}</div>
                      <div style={{ fontSize: 12, color: p.dim, marginTop: 2 }}>
                        {users.length} técnico{users.length > 1 ? 's' : ''} activo{users.length > 1 ? 's' : ''}
                      </div>
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                    {users.map((user, i) => (
                      <span key={user} style={{
                        padding: '5px 14px', borderRadius: 20, fontSize: 12, fontWeight: 600,
                        background: i === 0 ? ACCENT : p.chipBg,
                        color: i === 0 ? '#fff' : p.text,
                      }}>{user}</span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )
        ) : tab === 'history' ? (
          (() => {
            const filteredHistory = applyHistoryFilters(history, { period: historyPeriod, search: historyFilter, dateFrom, dateTo });
            const hasMore = historyOffset < historyTotal && historyPeriod === 'all' && !historyFilter;
            return (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {filteredHistory.length === 0 ? (
                  <div style={{ textAlign: 'center', padding: '60px 0', color: p.faint, fontSize: 14 }}>
                    {history.length === 0 ? 'Sin colisiones registradas aún' : 'Sin resultados — prueba cambiando los filtros'}
                  </div>
                ) : filteredHistory.map((e, i) => (
                  <div
                    key={i}
                    onClick={() => { if (e.ticketUrl) window.open(e.ticketUrl, '_blank', 'noopener,noreferrer'); }}
                    title={e.ticketUrl ? 'Abrir ticket en Autotask' : undefined}
                    style={{
                      background: p.chipBg2, border: `1px solid ${p.headerBorder}`,
                      borderRadius: 12, padding: '14px 20px',
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16,
                      cursor: e.ticketUrl ? 'pointer' : 'default',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                      <span style={{ color: '#ef4444', display: 'flex' }}><Icon name="alert-triangle" size={16} /></span>
                      <div>
                        <div style={{ fontSize: 13, fontWeight: 600 }}>{e.ticketNumber ?? `#${e.ticketId}`}</div>
                        <div style={{ fontSize: 11, color: p.faint, marginTop: 2 }}>
                          {new Date(e.ts).toLocaleString('es-CL')}
                        </div>
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                      {e.users.map((u, j) => (
                        <span key={u} style={{
                          padding: '3px 10px', borderRadius: 20, fontSize: 11, fontWeight: 600,
                          background: j === 0 ? 'rgba(56,103,233,0.2)' : p.chipBg2,
                          color: j === 0 ? ACCENT : p.dim,
                        }}>{u}</span>
                      ))}
                    </div>
                  </div>
                ))}
                {hasMore && (
                  <button onClick={loadMoreHistory} disabled={historyLoadingMore} style={{
                    margin: '4px auto 0', padding: '8px 20px', borderRadius: 20, fontSize: 12, fontWeight: 600,
                    fontFamily: 'inherit', cursor: historyLoadingMore ? 'default' : 'pointer', border: `1px solid ${p.inputBorder}`,
                    background: p.chipBg2, color: p.dim,
                  }}>
                    {historyLoadingMore ? 'Cargando...' : `Cargar más (${historyTotal - historyOffset} restantes)`}
                  </button>
                )}
              </div>
            );
          })()
        ) : tab === 'analytics' ? (
          analyticsLoading ? (
            <div style={{ textAlign: 'center', padding: '80px 0', color: p.faint, fontSize: 14 }}>Cargando...</div>
          ) : !analytics || !analytics.total ? (
            <div style={{ textAlign: 'center', padding: '80px 0', background: p.emptyBg, border: `1px dashed ${p.dashedBorder}`, borderRadius: 20 }}>
              <div style={{ marginBottom: 12, color: ACCENT, display: 'flex', justifyContent: 'center' }}><Icon name="bar-chart-3" size={40} /></div>
              <div style={{ fontSize: 15, color: p.dim }}>Sin datos aún</div>
              <div style={{ fontSize: 12, color: p.faint, marginTop: 4 }}>Las colisiones aparecerán aquí una vez registradas</div>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {analytics.byDay.length > 0 && (
                <div style={{ background: p.cardBg, border: `1px solid ${p.cardBorder}`, borderRadius: 16, padding: 24 }}>
                  <div style={{ fontSize: 14, fontWeight: 800, marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Icon name="calendar" size={15} color={ACCENT} /> Tendencia últimos 30 días
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: `repeat(${analytics.byDay.length}, 1fr)`, gap: 3, alignItems: 'end', height: 64 }}>
                    {analytics.byDay.map((d, i) => {
                      const max = Math.max(...analytics.byDay.map(x => x.count)) || 1;
                      const pct = Math.round((d.count / max) * 100);
                      return <div key={i} title={`${d.date} — ${d.count} col.`} style={{
                        background: 'rgba(56,103,233,0.3)', borderRadius: '2px 2px 0 0',
                        height: `${Math.max(pct, d.count > 0 ? 8 : 2)}%`, minHeight: 2,
                      }} />;
                    })}
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: `repeat(${analytics.byDay.length}, 1fr)`, gap: 3, marginTop: 4 }}>
                    {analytics.byDay.map((d, i) => (
                      <div key={i} style={{ fontSize: 7, color: p.faint, textAlign: 'center', overflow: 'hidden' }}>{i % 5 === 0 ? d.date.slice(8) : ''}</div>
                    ))}
                  </div>
                </div>
              )}

              <div style={{ background: p.cardBg, border: `1px solid ${p.cardBorder}`, borderRadius: 16, padding: 24 }}>
                <div style={{ fontSize: 14, fontWeight: 800, marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Icon name="users" size={15} color={ACCENT} /> Técnicos con más colisiones
                  <span style={{ fontWeight: 400, color: p.faint, fontSize: 12 }}>· total {analytics.total}</span>
                </div>
                {analytics.byTech.map((t, i) => {
                  const max = analytics.byTech[0]?.count || 1;
                  return (
                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                      <div style={{ width: 140, fontSize: 12, color: p.dim, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', flexShrink: 0 }} title={t.name}>{t.name}</div>
                      <div style={{ flex: 1, height: 10, background: p.chipBg2, borderRadius: 6, overflow: 'hidden' }}>
                        <div style={{ height: '100%', borderRadius: 6, width: `${Math.round((t.count / max) * 100)}%`, background: 'linear-gradient(90deg, #3867E9, #01BFFA)' }} />
                      </div>
                      <div style={{ width: 28, textAlign: 'right', fontSize: 11, color: p.dim, flexShrink: 0 }}>{t.count}</div>
                    </div>
                  );
                })}
              </div>

              {analytics.pairs.length > 0 && (
                <div style={{ background: p.cardBg, border: `1px solid ${p.cardBorder}`, borderRadius: 16, padding: 24 }}>
                  <div style={{ fontSize: 14, fontWeight: 800, marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Icon name="link-2" size={15} color={ACCENT} /> Pares que más colisionan
                  </div>
                  {analytics.pairs.map((pr, i) => {
                    const max = analytics.pairs[0]?.count || 1;
                    return (
                      <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                        <div style={{ width: 140, fontSize: 12, color: p.dim, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', flexShrink: 0 }} title={pr.pair}>{pr.pair}</div>
                        <div style={{ flex: 1, height: 10, background: p.chipBg2, borderRadius: 6, overflow: 'hidden' }}>
                          <div style={{ height: '100%', borderRadius: 6, width: `${Math.round((pr.count / max) * 100)}%`, background: 'linear-gradient(90deg, #8C52FF, #6d28d9)' }} />
                        </div>
                        <div style={{ width: 32, textAlign: 'right', fontSize: 11, color: p.dim, flexShrink: 0 }}>{pr.count}x</div>
                      </div>
                    );
                  })}
                </div>
              )}

              <div style={{ background: p.cardBg, border: `1px solid ${p.cardBorder}`, borderRadius: 16, padding: 24 }}>
                <div style={{ fontSize: 14, fontWeight: 800, marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Icon name="clock" size={15} color={ACCENT} /> Colisiones por hora del día
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(24, 1fr)', gap: 3, alignItems: 'end', height: 64 }}>
                  {analytics.byHour.map((c, h) => {
                    const max = Math.max(...analytics.byHour) || 1;
                    const pct = Math.round((c / max) * 100);
                    return <div key={h} title={`${h}:00 — ${c} colisiones`} style={{
                      background: 'rgba(1,191,250,0.3)', borderRadius: '2px 2px 0 0',
                      height: `${Math.max(pct, c > 0 ? 8 : 2)}%`, minHeight: 2,
                    }} />;
                  })}
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(24, 1fr)', gap: 3, marginTop: 4 }}>
                  {analytics.byHour.map((_, h) => (
                    <div key={h} style={{ fontSize: 8, color: p.faint, textAlign: 'center' }}>{h % 3 === 0 ? `${h}h` : ''}</div>
                  ))}
                </div>
              </div>

              {analytics.topTickets.length > 0 && (
                <div style={{ background: p.cardBg, border: `1px solid ${p.cardBorder}`, borderRadius: 16, padding: 24 }}>
                  <div style={{ fontSize: 14, fontWeight: 800, marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Icon name="ticket" size={15} color={ACCENT} /> Tickets con más colisiones
                  </div>
                  {analytics.topTickets.map((t, i) => {
                    const max = analytics.topTickets[0]?.count || 1;
                    return (
                      <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                        <div style={{ width: 140, fontSize: 12, color: p.dim, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', flexShrink: 0 }}>{t.ticket}</div>
                        <div style={{ flex: 1, height: 10, background: p.chipBg2, borderRadius: 6, overflow: 'hidden' }}>
                          <div style={{ height: '100%', borderRadius: 6, width: `${Math.round((t.count / max) * 100)}%`, background: 'linear-gradient(90deg, #3867E9, #2952cc)' }} />
                        </div>
                        <div style={{ width: 28, textAlign: 'right', fontSize: 11, color: p.dim, flexShrink: 0 }}>{t.count}</div>
                      </div>
                    );
                  })}
                </div>
              )}

              {analytics.avgDurationSecs != null && (
                <div style={{ background: p.cardBg, border: `1px solid ${p.cardBorder}`, borderRadius: 16, padding: 24 }}>
                  <div style={{ fontSize: 14, fontWeight: 800, marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Icon name="clock" size={15} color={ACCENT} /> Duración de colisiones
                    <span style={{ fontWeight: 400, color: p.faint, fontSize: 12 }}>· {analytics.resolvedCount} registradas</span>
                  </div>
                  <div style={{ display: 'flex', gap: 24 }}>
                    <div>
                      <div style={{ fontSize: 24, fontWeight: 800, color: ACCENT }}>
                        {Math.floor(analytics.avgDurationSecs / 60) > 0 ? `${Math.floor(analytics.avgDurationSecs / 60)}m ` : ''}{analytics.avgDurationSecs % 60}s
                      </div>
                      <div style={{ fontSize: 11, color: p.dim, marginTop: 2 }}>Duración promedio</div>
                    </div>
                    <div>
                      <div style={{ fontSize: 24, fontWeight: 700, color: p.dim }}>
                        {Math.floor((analytics.maxDurationSecs ?? 0) / 60) > 0 ? `${Math.floor((analytics.maxDurationSecs ?? 0) / 60)}m ` : ''}{(analytics.maxDurationSecs ?? 0) % 60}s
                      </div>
                      <div style={{ fontSize: 11, color: p.dim, marginTop: 2 }}>Máxima registrada</div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )
        ) : tab === 'resources' ? (
          <div style={{ background: p.cardBg, border: `1px solid ${p.cardBorder}`, borderRadius: 16, padding: '24px 28px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <Icon name="users" size={16} color={ACCENT} />
              <div style={{ fontSize: 14, fontWeight: 700 }}>Roster de técnicos</div>
            </div>
            <div style={{ fontSize: 12, color: p.dim, marginBottom: 18, lineHeight: 1.5 }}>
              Trae los técnicos activos desde Autotask y los guarda en Supabase. Solo los técnicos en este roster pueden quedar registrados en colisiones, notificaciones y feedback — así ningún nombre inventado o externo se cuela en el historial.
            </div>
            <button onClick={syncResources} disabled={syncLoading} style={{
              padding: '9px 20px', borderRadius: 10, fontSize: 13, fontWeight: 600, fontFamily: 'inherit',
              background: ACCENT, color: '#fff', border: 'none', cursor: syncLoading ? 'default' : 'pointer',
            }}>{syncLoading ? 'Sincronizando...' : 'Sincronizar desde Autotask'}</button>
            {syncStatus && (
              <div style={{ fontSize: 12, marginTop: 12, color: syncStatus.includes('✗') || syncStatus.includes('⚠') ? '#ef4444' : '#22c55e' }}>{syncStatus}</div>
            )}
          </div>
        ) : tab === 'notifications' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {notifLog.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '80px 0', background: p.emptyBg, border: `1px dashed ${p.dashedBorder}`, borderRadius: 20 }}>
                <div style={{ marginBottom: 12, color: ACCENT, display: 'flex', justifyContent: 'center' }}><Icon name="inbox" size={40} /></div>
                <div style={{ fontSize: 15, color: p.dim }}>Sin notificaciones aún</div>
                <div style={{ fontSize: 12, color: p.faint, marginTop: 4 }}>Aquí aparecerán colisiones, avisos y alertas de Autotask (n1–n5) de todo el equipo</div>
              </div>
            ) : (
              <>
                {notifLog.map((n, i) => {
                  const meta = NOTIF_META[n.type] ?? NOTIF_META_DEFAULT;
                  return (
                    <div key={i} style={{
                      background: p.chipBg2, border: `1px solid ${p.headerBorder}`,
                      borderLeft: `3px solid ${meta.color}`,
                      borderRadius: 12, padding: '12px 18px',
                      display: 'flex', alignItems: 'flex-start', gap: 12,
                    }}>
                      <div style={{ color: meta.color, marginTop: 2, flexShrink: 0 }}><Icon name={meta.icon} size={17} /></div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 700 }}>{n.title}</div>
                        <div style={{ fontSize: 12, color: p.dim, marginTop: 2 }}>{n.body}</div>
                        <div style={{ fontSize: 11, color: p.faint, marginTop: 4, display: 'flex', gap: 6, alignItems: 'center' }}>
                          {(n.ticketNumber || n.ticketId) && (
                            <span style={{ color: ACCENT, fontWeight: 600 }}>{n.ticketNumber ?? `#${n.ticketId}`}</span>
                          )}
                          <span>·</span>
                          <span>{relTime(n.ts)}</span>
                        </div>
                      </div>
                    </div>
                  );
                })}
                {notifLog.length < notifTotal && (
                  <button onClick={loadMoreNotifs} disabled={notifLoadingMore} style={{
                    margin: '4px auto 0', padding: '8px 20px', borderRadius: 20, fontSize: 12, fontWeight: 600,
                    fontFamily: 'inherit', cursor: notifLoadingMore ? 'default' : 'pointer', border: `1px solid ${p.inputBorder}`,
                    background: p.chipBg2, color: p.dim,
                  }}>
                    {notifLoadingMore ? 'Cargando...' : `Cargar más (${notifTotal - notifLog.length} restantes)`}
                  </button>
                )}
              </>
            )}
          </div>
        ) : tab === 'feedback' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {feedbackItems.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '80px 0', background: p.emptyBg, border: `1px dashed ${p.dashedBorder}`, borderRadius: 20 }}>
                <div style={{ marginBottom: 12, color: ACCENT, display: 'flex', justifyContent: 'center' }}><Icon name="message-square" size={40} /></div>
                <div style={{ fontSize: 15, color: p.dim }}>Sin feedback aún</div>
                <div style={{ fontSize: 12, color: p.faint, marginTop: 4 }}>Lo que envíen los técnicos desde la extensión aparecerá aquí</div>
              </div>
            ) : (
              <>
                {feedbackItems.map((f) => {
                  const meta = FEEDBACK_META[f.type] ?? FEEDBACK_META.otro;
                  return (
                    <div key={f.id} style={{
                      background: p.chipBg2, border: `1px solid ${p.headerBorder}`,
                      borderLeft: `3px solid ${meta.color}`,
                      borderRadius: 12, padding: '12px 18px',
                      display: 'flex', alignItems: 'flex-start', gap: 12,
                    }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                          <span style={{
                            padding: '2px 9px', borderRadius: 20, fontSize: 10, fontWeight: 700,
                            background: `${meta.color}22`, color: meta.color,
                          }}>{meta.label}</span>
                          <span style={{ fontSize: 12, fontWeight: 600 }}>{f.resource_name}</span>
                        </div>
                        <div style={{ fontSize: 13, color: p.text, lineHeight: 1.4 }}>{f.message}</div>
                        <div style={{ fontSize: 11, color: p.faint, marginTop: 6 }}>{relTime(new Date(f.created_at).getTime())}</div>
                      </div>
                    </div>
                  );
                })}
                {feedbackItems.length < feedbackTotal && (
                  <button onClick={loadMoreFeedback} disabled={feedbackLoadingMore} style={{
                    margin: '4px auto 0', padding: '8px 20px', borderRadius: 20, fontSize: 12, fontWeight: 600,
                    fontFamily: 'inherit', cursor: feedbackLoadingMore ? 'default' : 'pointer', border: `1px solid ${p.inputBorder}`,
                    background: p.chipBg2, color: p.dim,
                  }}>
                    {feedbackLoadingMore ? 'Cargando...' : `Cargar más (${feedbackTotal - feedbackItems.length} restantes)`}
                  </button>
                )}
              </>
            )}
          </div>
        ) : (
          <div style={{ background: p.cardBg, border: `1px solid ${p.cardBorder}`, borderRadius: 16, padding: '24px 28px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <Icon name="satellite" size={16} color={ACCENT} />
              <div style={{ fontSize: 14, fontWeight: 700 }}>Notificaciones Autotask (n1–n5)</div>
            </div>
            <div style={{ fontSize: 12, color: p.dim, marginBottom: 18, lineHeight: 1.5 }}>
              Centro de notificaciones &quot;COLview&quot;. El servidor sondea Autotask y avisa a cada técnico en su extensión: ticket entrante en la cola (n1), asignación (n2), respuesta de cliente (n3), SLA por vencer (n4) y ticket crítico en la cola (n5).
            </div>

            <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, cursor: 'pointer' }}>
              <span style={{ fontSize: 13, color: p.text }}>Activar poller n1–n5</span>
              <input type="checkbox" checked={notifEnabled} onChange={e => setNotifEnabled(e.target.checked)} style={{ width: 18, height: 18, accentColor: ACCENT, cursor: 'pointer' }} />
            </label>

            <label style={{ display: 'block', fontSize: 11, color: p.dim, marginBottom: 4 }}>Colas a vigilar (queueID, separados por coma) — para n1 y n5</label>
            <input
              value={watchQueues} onChange={e => setWatchQueues(e.target.value)} placeholder="Ej: 8, 29, 14"
              style={{
                width: '100%', padding: '9px 12px', borderRadius: 8, fontSize: 13, fontFamily: 'inherit',
                background: p.inputBg, border: `1px solid ${p.inputBorder}`, color: p.text,
                boxSizing: 'border-box', outline: 'none', marginBottom: 14,
              }}
            />

            <label style={{ display: 'block', fontSize: 11, color: p.dim, marginBottom: 4 }}>IDs de prioridad considerada &quot;crítica&quot; — para n5</label>
            <input
              value={criticalPriorities} onChange={e => setCriticalPriorities(e.target.value)} placeholder="Ej: 1"
              style={{
                width: '100%', padding: '9px 12px', borderRadius: 8, fontSize: 13, fontFamily: 'inherit',
                background: p.inputBg, border: `1px solid ${p.inputBorder}`, color: p.text,
                boxSizing: 'border-box', outline: 'none', marginBottom: 14,
              }}
            />

            <label style={{ display: 'block', fontSize: 11, color: p.dim, marginBottom: 4 }}>Aviso de SLA (min antes de vencer) — n4</label>
            <input
              type="number" min={5} max={1440} step={5} value={slaWarnMin}
              onChange={e => setSlaWarnMin(parseInt(e.target.value) || 30)}
              style={{
                width: 140, padding: '9px 12px', borderRadius: 8, fontSize: 13, fontFamily: 'inherit',
                background: p.inputBg, border: `1px solid ${p.inputBorder}`, color: p.text,
                boxSizing: 'border-box', outline: 'none', marginBottom: 14,
              }}
            />

            <label style={{ display: 'block', fontSize: 11, color: p.dim, marginBottom: 4 }}>Base de la UI de Autotask (para enlazar tickets) — opcional</label>
            <input
              type="url" value={autotaskUiBase} onChange={e => setAutotaskUiBase(e.target.value)} placeholder="https://ww5.autotask.net"
              style={{
                width: '100%', padding: '9px 12px', borderRadius: 8, fontSize: 13, fontFamily: 'inherit',
                background: p.inputBg, border: `1px solid ${p.inputBorder}`, color: p.text,
                boxSizing: 'border-box', outline: 'none', marginBottom: 18,
              }}
            />

            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <button onClick={saveNotifConfig} style={{
                padding: '9px 20px', borderRadius: 10, fontSize: 13, fontWeight: 600, fontFamily: 'inherit',
                background: ACCENT, color: '#fff', border: 'none', cursor: 'pointer',
              }}>Guardar</button>
              <button onClick={pollNow} disabled={pollLoading} style={{
                padding: '9px 20px', borderRadius: 10, fontSize: 13, fontWeight: 600, fontFamily: 'inherit',
                background: p.chipBg2, color: p.text, border: `1px solid ${p.inputBorder}`,
                cursor: pollLoading ? 'default' : 'pointer',
              }}>{pollLoading ? 'Sondeando...' : 'Sondear ahora'}</button>
            </div>
            {(configStatus || pollStatus) && (
              <div style={{
                fontSize: 12, marginTop: 12,
                color: (configStatus.includes('✗') || pollStatus.includes('✗') || pollStatus.includes('⚠')) ? '#ef4444' : '#22c55e',
              }}>
                {configStatus === 'saving' ? 'Guardando...' : configStatus}
                {configStatus && configStatus !== 'saving' && pollStatus ? ' · ' : ''}
                {pollStatus}
              </div>
            )}
          </div>
        )}

        {tab === 'config' && (
          <>
            <div style={{ background: p.cardBg, border: `1px solid ${p.cardBorder}`, borderRadius: 16, padding: '24px 28px', marginTop: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <Icon name="clipboard-list" size={16} color={ACCENT} />
                <div style={{ fontSize: 14, fontWeight: 700 }}>Nota automática en Autotask</div>
              </div>
              <div style={{ fontSize: 12, color: p.dim, marginBottom: 16, lineHeight: 1.5 }}>
                Cuando se detecta o resuelve una colisión, crea una nota en el ticket con los detalles del evento.{' '}
                <strong>Valida los valores de tipo/visibilidad de nota contra tu instancia de Autotask antes de activar esto en producción</strong> — por defecto la nota queda como interna, no visible al cliente.
              </div>
              <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer', width: 'fit-content', gap: 16 }}>
                <span style={{ fontSize: 13, color: p.text }}>Activar nota automática</span>
                <input type="checkbox" checked={autotaskNotesEnabled} onChange={e => setAutotaskNotesEnabled(e.target.checked)} style={{ width: 18, height: 18, accentColor: ACCENT, cursor: 'pointer' }} />
              </label>
            </div>

            <div style={{ background: p.cardBg, border: `1px solid ${p.cardBorder}`, borderRadius: 16, padding: '24px 28px', marginTop: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <Icon name="user" size={16} color={ACCENT} />
                <div style={{ fontSize: 14, fontWeight: 700 }}>Cambiar contraseña de admin</div>
              </div>
              <div style={{ fontSize: 12, color: p.dim, marginBottom: 16, lineHeight: 1.5 }}>
                Cambia la contraseña que protege ambos paneles de administración. Si la variable de entorno ADMIN_PASSWORD está seteada en Vercel, este cambio no tendrá efecto hasta que se borre esa variable.
              </div>
              <input
                type="password" value={currentPwd} onChange={e => setCurrentPwd(e.target.value)} placeholder="Contraseña actual"
                style={{
                  width: '100%', padding: '9px 12px', borderRadius: 8, fontSize: 13, fontFamily: 'inherit',
                  background: p.inputBg, border: `1px solid ${p.inputBorder}`, color: p.text,
                  boxSizing: 'border-box', outline: 'none', marginBottom: 10,
                }}
              />
              <input
                type="password" value={newPwd} onChange={e => setNewPwd(e.target.value)} placeholder="Contraseña nueva"
                style={{
                  width: '100%', padding: '9px 12px', borderRadius: 8, fontSize: 13, fontFamily: 'inherit',
                  background: p.inputBg, border: `1px solid ${p.inputBorder}`, color: p.text,
                  boxSizing: 'border-box', outline: 'none', marginBottom: 14,
                }}
              />
              <button onClick={changeAdminPassword} style={{
                padding: '9px 20px', borderRadius: 10, fontSize: 13, fontWeight: 600, fontFamily: 'inherit',
                background: ACCENT, color: '#fff', border: 'none', cursor: 'pointer',
              }}>Cambiar contraseña</button>
              {pwdChangeStatus && (
                <div style={{ fontSize: 12, marginTop: 12, color: pwdChangeStatus.includes('✗') ? '#ef4444' : '#22c55e' }}>{pwdChangeStatus}</div>
              )}
            </div>
          </>
        )}
      </div>

      <Footer color={p.faint} background={p.headerBg} border={p.headerBorder} />

      <style>{`
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
        input::placeholder { color: ${p.faint}; }
      `}</style>
    </div>
  );
}
