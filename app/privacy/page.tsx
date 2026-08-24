const H2 = { fontSize: 18, marginTop: 32, marginBottom: 8 } as const;
const UL = { paddingLeft: 20, lineHeight: 2 } as const;

export default function PrivacyPage() {
  return (
    <div style={{ fontFamily: 'Segoe UI, sans-serif', maxWidth: 720, margin: '60px auto', padding: '0 24px', color: '#1a1a2e' }}>
      <h1 style={{ fontSize: 28, fontWeight: 700, marginBottom: 8 }}>Política de Privacidad</h1>
      <p style={{ color: '#666', marginBottom: 32 }}>Autotask CoView · Netsus SpA · Última actualización: agosto 2026</p>

      <p>
        Autotask CoView es una extensión de uso interno de Netsus SpA. Avisa a los técnicos
        cuando dos personas abren el mismo ticket de Autotask al mismo tiempo, para que no
        dupliquen trabajo. Solo la usan empleados de Netsus sobre tickets de Autotask; no
        está dirigida al público general ni recoge datos de los clientes finales.
      </p>

      <h2 style={H2}>¿Qué datos se recopilan?</h2>
      <ul style={UL}>
        <li>El <strong>nombre del técnico</strong>, detectado desde la interfaz de Autotask o escrito manualmente en la extensión.</li>
        <li>El <strong>identificador y número del ticket</strong> que el técnico tiene abierto, y su enlace.</li>
        <li>La <strong>hora de entrada y salida</strong> del ticket, y la duración de cada coincidencia.</li>
        <li>Los <strong>avisos generados</strong> (cola, asignación, respuesta de cliente, SLA, ticket crítico) y a qué técnico se dirigieron.</li>
        <li>El <strong>feedback</strong> que el técnico envía voluntariamente desde la extensión, junto a su nombre.</li>
        <li><strong>Errores técnicos</strong> del servidor (mensaje y traza), para diagnóstico.</li>
      </ul>
      <p>
        No se registran pulsaciones de teclas, historial de navegación, ni el contenido de los
        tickets más allá de su número, título y estado.
      </p>

      <h2 style={H2}>¿Cómo se usan?</h2>
      <p>
        Exclusivamente para detectar coincidencias entre técnicos, avisarles en tiempo real y
        permitir que la administración de Netsus revise el historial y las métricas agregadas
        del equipo. No se usan para publicidad, no se venden, y no se emplean para elaborar
        perfiles automatizados con efectos sobre las personas.
      </p>

      <h2 style={H2}>¿Dónde se almacenan y por cuánto tiempo?</h2>
      <ul style={UL}>
        <li>
          <strong>Upstash (Redis)</strong> — presencia en tiempo real, configuración y cachés.
          Son datos efímeros con expiración automática: la marca de presencia caduca a los
          40 segundos por omisión (configurable entre 15 y 300), y los datos auxiliares
          entre 10 minutos y unas horas.
        </li>
        <li>
          <strong>Supabase (PostgreSQL)</strong> — almacenamiento <strong>duradero</strong>. Aquí
          persisten el historial de coincidencias, el roster de técnicos, el feed de avisos, el
          feedback y el registro de errores. Estos datos <strong>no expiran solos</strong>: se
          conservan mientras el servicio esté en uso y se eliminan cuando un administrador de
          Netsus los borra desde el panel de administración, que permite borrado individual o
          total.
        </li>
      </ul>

      <h2 style={H2}>¿Con quién se comparten?</h2>
      <p>
        No se venden ni se ceden a terceros con fines comerciales. Para funcionar, el servicio
        transmite datos a los siguientes proveedores, que actúan como encargados del
        tratamiento por cuenta de Netsus:
      </p>
      <ul style={UL}>
        <li><strong>Microsoft (Teams)</strong> — cuando se detecta una coincidencia se publica un aviso en un canal interno de Netsus, incluyendo los nombres de los técnicos implicados y el ticket.</li>
        <li><strong>Microsoft (Graph / Microsoft 365)</strong> — envío del correo de feedback al buzón interno de Netsus.</li>
        <li><strong>Datto (Autotask PSA)</strong> — origen de los datos: la extensión consulta la API de Autotask para leer estado y asignación de los tickets.</li>
        <li><strong>Vercel</strong> — alojamiento del servidor. <strong>Upstash</strong> y <strong>Supabase</strong> — bases de datos descritas arriba.</li>
      </ul>

      <h2 style={H2}>¿Quién puede ver los datos?</h2>
      <p>
        El historial y las métricas solo son accesibles desde el panel de administración de
        Netsus, protegido por contraseña. Los técnicos ven, dentro de la extensión, quién más
        está en el ticket que tienen abierto y sus propias estadísticas. No se expone
        información a usuarios externos ni a los clientes de Netsus.
      </p>

      <h2 style={H2}>Permisos de la extensión</h2>
      <ul style={UL}>
        <li><strong>storage</strong>: guardar el nombre del técnico y sus preferencias en el navegador.</li>
        <li><strong>notifications</strong>: mostrar avisos del sistema operativo ante una coincidencia.</li>
        <li><strong>tabs</strong> y <strong>scripting</strong>: saber si la pestaña activa es un ticket y activar la extensión en ella.</li>
        <li><strong>alarms</strong>: mantener vivo el proceso en segundo plano que consulta los avisos.</li>
        <li><strong>sidePanel</strong>: mostrar el panel lateral de la extensión.</li>
        <li><strong>Acceso a <code>*.autotask.net</code></strong>: leer el nombre del técnico y el ticket abierto desde la interfaz de Autotask.</li>
        <li><strong>Acceso a <code>netsus-two.vercel.app</code></strong>: comunicarse con el servidor de presencia.</li>
      </ul>

      <h2 style={H2}>Tus derechos</h2>
      <p>
        Cualquier técnico de Netsus puede solicitar acceso, corrección o eliminación de los
        datos asociados a su nombre escribiendo a la dirección de contacto. La eliminación se
        efectúa desde el panel de administración.
      </p>

      <h2 style={H2}>Contacto</h2>
      <p>Para consultas sobre privacidad: <a href="mailto:soporte@netsus.cl">soporte@netsus.cl</a></p>
    </div>
  );
}
