'use client';

import { useState } from 'react';
import { Montserrat } from 'next/font/google';
import { Icon, type IconName } from '@/lib/icons';

const montserrat = Montserrat({ subsets: ['latin'], weight: ['300', '400', '600', '800'] });

const ACCENT = '#3867E9';
const PAGE_BG = 'linear-gradient(135deg, #190637 0%, #0d0320 100%)';
const TEXT = '#fff';
const DIM = 'rgba(255,255,255,0.55)';
const FAINT = 'rgba(255,255,255,0.35)';
const CARD_BG = 'rgba(255,255,255,0.04)';
const CARD_BORDER = 'rgba(255,255,255,0.08)';

const VALUE_PROPS: { icon: IconName; title: string; body: string }[] = [
  { icon: 'zap', title: 'En tiempo real', body: 'Se enteran al instante, no después del hecho — cuando el daño ya está hecho.' },
  { icon: 'check-circle', title: 'Cero fricción', body: 'Se activa solo al entrar a un ticket de Autotask. Nadie tiene que configurar nada.' },
  { icon: 'bar-chart-3', title: 'Historial y métricas', body: 'Todo queda registrado — el equipo ve el panorama completo desde el panel admin.' },
];

const FEATURES: { icon: IconName; title: string; body: string }[] = [
  { icon: 'alert-triangle', title: 'Detección de colisiones', body: 'Banner en vivo dentro del propio ticket, con nombre, avatar y tiempo del otro técnico.' },
  { icon: 'bell', title: 'Notificaciones proactivas', body: 'Ticket nuevo en cola, asignación, respuesta del cliente, SLA por vencer y prioridad crítica.' },
  { icon: 'satellite', title: 'Side panel', body: 'Sigue la pestaña activa y muestra el estado y el buzón de avisos sin salir de Autotask.' },
  { icon: 'bar-chart-3', title: 'Panel de administración', body: 'Vista en vivo de quién está en qué ticket, historial exportable y analítica del equipo.' },
  { icon: 'users', title: 'Roster del equipo', body: 'Sincronizado automáticamente desde Autotask, con cargo y disponibilidad real.' },
  { icon: 'link-2', title: 'Integración nativa', body: 'Vive dentro de Autotask — sin cambiar de pestaña ni aprender una herramienta nueva.' },
];

const STEPS: { title: string; body: string }[] = [
  { title: 'Técnico A abre un ticket', body: 'CoView registra su presencia automáticamente. No hay que avisar ni marcar nada a mano.' },
  { title: 'Técnico B abre el mismo ticket', body: 'La coincidencia se detecta al instante, apenas la segunda persona entra.' },
  { title: 'Ambos ven el aviso', body: 'Un banner aparece en la propia página: quién llegó primero, hace cuánto, y botones para avisar, pausar o marcar "Terminé".' },
  { title: 'Se resuelve solo', body: 'Cuando uno de los dos sale del ticket, el otro ve de inmediato que quedó libre — sin recargar nada.' },
  { title: 'Queda registrado', body: 'La colisión pasa al historial y a las métricas del panel admin, lista para revisar cuando se necesite.' },
];

function Section({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{ maxWidth: 1000, margin: '0 auto', padding: '0 24px', width: '100%', boxSizing: 'border-box', ...style }}>
      {children}
    </div>
  );
}

export default function Home() {
  const [step, setStep] = useState(0);

  return (
    <div className={montserrat.className} style={{ background: PAGE_BG, color: TEXT, minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      {/* Hero: panel partido estilo pantalla de login — marca a la izquierda, acceso a la derecha */}
      <div style={{ display: 'flex', flexWrap: 'wrap', minHeight: '100vh' }}>
        <div style={{
          flex: '1 1 480px', minHeight: 480, position: 'relative', overflow: 'hidden',
          background: PAGE_BG, padding: '36px 44px', display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
        }}>
          {/* patrón decorativo de cuadrícula, puramente visual */}
          <div style={{
            position: 'absolute', inset: 0, opacity: 0.5, pointerEvents: 'none',
            backgroundImage: 'radial-gradient(rgba(255,255,255,0.08) 1.5px, transparent 1.5px)',
            backgroundSize: '26px 26px',
            maskImage: 'radial-gradient(circle at 30% 70%, #000 0%, transparent 65%)',
            WebkitMaskImage: 'radial-gradient(circle at 30% 70%, #000 0%, transparent 65%)',
          }} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, position: 'relative' }}>
            <img src="/netsus-logo.png" alt="netsus" style={{ height: 20 }} />
          </div>
          <div style={{ position: 'relative', maxWidth: 440 }}>
            <h1 style={{ fontSize: 34, fontWeight: 800, lineHeight: 1.25, margin: '0 0 16px' }}>
              Evita que dos técnicos trabajen el mismo ticket sin saberlo
            </h1>
            <p style={{ fontSize: 14, color: DIM, lineHeight: 1.7, margin: 0 }}>
              Autotask CoView avisa en tiempo real cuando dos técnicos abren el mismo ticket a la vez —
              para que nunca más se dupliquen notas, ni el cliente reciba dos respuestas distintas.
            </p>
          </div>
        </div>

        <div style={{
          flex: '1 1 360px', minHeight: 480, background: 'rgba(255,255,255,0.05)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '44px 32px',
        }}>
          <div style={{ maxWidth: 300, textAlign: 'center' }}>
            <div style={{
              width: 44, height: 44, borderRadius: 12, background: 'rgba(56,103,233,0.15)', color: ACCENT,
              display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 20px',
            }}>
              <Icon name="satellite" size={21} />
            </div>
            <div style={{ fontSize: 19, fontWeight: 800, marginBottom: 8 }}>Acceder al panel</div>
            <div style={{ fontSize: 13, color: DIM, marginBottom: 28, lineHeight: 1.6 }}>
              Panel de administración de Autotask CoView — uso interno del equipo de soporte.
            </div>
            <a
              href="/admin"
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, width: '100%',
                padding: '13px 20px', borderRadius: 10, boxSizing: 'border-box',
                background: ACCENT, color: '#fff', fontSize: 14, fontWeight: 600, textDecoration: 'none',
                boxShadow: '0 8px 24px rgba(56,103,233,0.35)',
              }}
            >
              Login <Icon name="link-2" size={15} />
            </a>
            <div style={{ fontSize: 11, color: FAINT, marginTop: 20 }}>
              Solo uso interno · Equipo de soporte Netsus
            </div>
          </div>
        </div>
      </div>

      {/* Value props */}
      <Section style={{ paddingBottom: 72 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 16 }}>
          {VALUE_PROPS.map((v) => (
            <div key={v.title} style={{ background: CARD_BG, border: `1px solid ${CARD_BORDER}`, borderRadius: 16, padding: '28px 24px' }}>
              <div style={{
                width: 40, height: 40, borderRadius: 10, background: 'rgba(56,103,233,0.15)', color: ACCENT,
                display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 16,
              }}>
                <Icon name={v.icon} size={19} />
              </div>
              <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 8 }}>{v.title}</div>
              <div style={{ fontSize: 13, color: DIM, lineHeight: 1.6 }}>{v.body}</div>
            </div>
          ))}
        </div>
      </Section>

      {/* Features */}
      <Section style={{ paddingBottom: 72 }}>
        <h2 style={{ fontSize: 24, fontWeight: 800, marginBottom: 8, textAlign: 'center' }}>Qué incluye</h2>
        <p style={{ fontSize: 13, color: DIM, textAlign: 'center', marginBottom: 36 }}>
          Todo lo que necesita el equipo de soporte, sin salir de Autotask.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 16 }}>
          {FEATURES.map((f) => (
            <div key={f.title} style={{ background: CARD_BG, border: `1px solid ${CARD_BORDER}`, borderRadius: 14, padding: '22px 20px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                <div style={{
                  width: 32, height: 32, borderRadius: 8, background: 'rgba(255,255,255,0.06)', color: ACCENT,
                  display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                }}>
                  <Icon name={f.icon} size={16} />
                </div>
                <div style={{ fontSize: 14, fontWeight: 700 }}>{f.title}</div>
              </div>
              <div style={{ fontSize: 13, color: DIM, lineHeight: 1.6 }}>{f.body}</div>
            </div>
          ))}
        </div>
      </Section>

      {/* Interactive guide */}
      <Section style={{ paddingBottom: 96 }}>
        <h2 style={{ fontSize: 24, fontWeight: 800, marginBottom: 8, textAlign: 'center' }}>Cómo funciona</h2>
        <p style={{ fontSize: 13, color: DIM, textAlign: 'center', marginBottom: 36 }}>
          Haz clic en cada paso para ver el flujo completo de una colisión.
        </p>
        <div style={{ background: CARD_BG, border: `1px solid ${CARD_BORDER}`, borderRadius: 20, padding: '32px 28px' }}>
          <div style={{ display: 'flex', gap: 4, marginBottom: 28, flexWrap: 'wrap', justifyContent: 'center' }}>
            {STEPS.map((s, i) => (
              <button
                key={s.title}
                onClick={() => setStep(i)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8, border: 'none', cursor: 'pointer',
                  padding: '8px 14px', borderRadius: 10, fontFamily: 'inherit', fontSize: 12, fontWeight: 600,
                  background: step === i ? ACCENT : 'rgba(255,255,255,0.05)',
                  color: step === i ? '#fff' : FAINT,
                }}
              >
                <span style={{
                  width: 18, height: 18, borderRadius: '50%', fontSize: 10, display: 'flex',
                  alignItems: 'center', justifyContent: 'center',
                  background: step === i ? 'rgba(255,255,255,0.25)' : 'rgba(255,255,255,0.08)',
                }}>{i + 1}</span>
                <span className="step-label">{s.title}</span>
              </button>
            ))}
          </div>
          <div style={{ textAlign: 'center', maxWidth: 480, margin: '0 auto' }}>
            <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 10 }}>{STEPS[step].title}</div>
            <div style={{ fontSize: 14, color: DIM, lineHeight: 1.7 }}>{STEPS[step].body}</div>
          </div>
        </div>
      </Section>

      {/* Footer */}
      <div style={{ borderTop: `1px solid ${CARD_BORDER}`, padding: '20px 0', textAlign: 'center', fontSize: 11, color: FAINT, marginTop: 'auto' }}>
        <b style={{ color: ACCENT, fontWeight: 800 }}>netsus</b>&nbsp;· Innovación Tecnológica
        &nbsp;·&nbsp;<a href="/privacy" style={{ color: FAINT }}>Política de privacidad</a>
      </div>

      <style>{`
        @media (max-width: 640px) {
          .step-label { display: none; }
        }
      `}</style>
    </div>
  );
}
