export default function PrivacyPage() {
  return (
    <div style={{ fontFamily: 'Segoe UI, sans-serif', maxWidth: 720, margin: '60px auto', padding: '0 24px', color: '#1a1a2e' }}>
      <h1 style={{ fontSize: 28, fontWeight: 700, marginBottom: 8 }}>Política de Privacidad</h1>
      <p style={{ color: '#666', marginBottom: 32 }}>Autotask CoView · Netsus · Última actualización: agosto 2026</p>

      <h2 style={{ fontSize: 18, marginTop: 32, marginBottom: 8 }}>¿Qué datos recopila la extensión?</h2>
      <p>La extensión recopila únicamente:</p>
      <ul style={{ paddingLeft: 20, lineHeight: 2 }}>
        <li>El <strong>nombre del técnico</strong> detectado desde la interfaz de Autotask (o configurado manualmente).</li>
        <li>El <strong>ID y número del ticket</strong> de Autotask que el técnico tiene abierto en ese momento.</li>
        <li>La <strong>hora de entrada</strong> al ticket (timestamp).</li>
      </ul>

      <h2 style={{ fontSize: 18, marginTop: 32, marginBottom: 8 }}>¿Cómo se usan los datos?</h2>
      <p>Los datos se usan exclusivamente para detectar cuando dos técnicos abren el mismo ticket simultáneamente y alertarles en tiempo real. No se usan para publicidad ni se comparten con terceros.</p>

      <h2 style={{ fontSize: 18, marginTop: 32, marginBottom: 8 }}>¿Dónde se almacenan?</h2>
      <p>Los datos se almacenan temporalmente en Redis (Upstash) con un TTL de 40 segundos para presencia activa y hasta 5 minutos para el historial de colisiones. Se eliminan automáticamente al cerrar el ticket o expirar el tiempo.</p>

      <h2 style={{ fontSize: 18, marginTop: 32, marginBottom: 8 }}>¿Quién tiene acceso?</h2>
      <p>Solo el personal de Netsus con acceso al panel de administración (protegido por contraseña) puede ver el historial de colisiones. No se expone información a usuarios externos.</p>

      <h2 style={{ fontSize: 18, marginTop: 32, marginBottom: 8 }}>Permisos de la extensión</h2>
      <ul style={{ paddingLeft: 20, lineHeight: 2 }}>
        <li><strong>storage</strong>: guardar el nombre del técnico localmente en el navegador.</li>
        <li><strong>notifications</strong>: mostrar alertas nativas del sistema operativo cuando se detecta una colisión.</li>
        <li><strong>host_permissions (*.autotask.net)</strong>: leer el nombre del técnico desde la interfaz de Autotask.</li>
        <li><strong>host_permissions (netsus-two.vercel.app)</strong>: comunicarse con el servidor de presencia.</li>
      </ul>

      <h2 style={{ fontSize: 18, marginTop: 32, marginBottom: 8 }}>Contacto</h2>
      <p>Para consultas sobre privacidad: <a href="mailto:soporte@netsus.cl">soporte@netsus.cl</a></p>
    </div>
  );
}
