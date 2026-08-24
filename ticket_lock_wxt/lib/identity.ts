// Interpretación del objeto que Autotask deja en la página con los datos del usuario
// logueado (`window.walkMeData`). Es el ÚNICO punto del proyecto que depende de la
// forma de una estructura de terceros: no está documentada ni es contractual, y el
// propio objeto expone `applicationVersionNumber` (cambia con cada release de Datto).
//
// Por eso vive acá y no dentro de un entrypoint: función pura, sin imports y sin
// tocar `window`, para poder cubrirla con tests (lib/identity.test.ts) sin levantar
// el runtime de la extensión. La usan el puente del main world
// (entrypoints/walkme-bridge.content.ts) y el fallback de Firefox en content.ts.

/** Forma mínima que nos interesa. Todo `unknown`: viene de terceros, no confiamos. */
export interface WalkMeLike {
  narrativeFullName?: unknown;
  firstName?: unknown;
  lastName?: unknown;
}

// Filtro de sanidad, NO de seguridad: el límite real lo pone sanitizeUser() en el
// servidor, que es la frontera de confianza. Acá solo descartamos valores que
// evidentemente no son un nombre (markup, JSON, cadenas larguísimas) antes de
// publicarlos en el DOM. Se permiten dígitos y puntuación básica para no rechazar
// nombres reales del roster; el tope de 60 caracteres coincide con el del servidor.
const PLAUSIBLE_NAME = /^[\p{L}\p{N}][\p{L}\p{N}\s.'’-]{1,59}$/u;

function clean(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().replace(/\s+/g, ' ');
  if (!trimmed || !PLAUSIBLE_NAME.test(trimmed)) return null;
  return trimmed;
}

/**
 * Devuelve el nombre del técnico, o `null` si el objeto no lo trae de forma
 * reconocible. Nunca lanza: la página podría exponer estos campos con un getter
 * que reviente, y un throw acá dejaría al técnico sin detección de colisiones.
 */
export function readNameFrom(source: unknown): string | null {
  if (!source || typeof source !== 'object') return null;
  try {
    const wmd = source as WalkMeLike;
    const full = clean(wmd.narrativeFullName);
    if (full) return full;
    const first = clean(wmd.firstName);
    const last = clean(wmd.lastName);
    if (first && last) return `${first} ${last}`;
  } catch {
    // Getter hostil o proxy que lanza — seguimos sin nombre, que es el fallback
    // seguro (el técnico puede escribirlo a mano).
  }
  return null;
}
