import { readNameFrom } from '@/lib/identity';
import { IDENTITY_DATASET_KEY, IDENTITY_PUBLISH_WINDOW_MS } from '@/lib/identity-bridge';

// Puente al "main world" de la página, para leer el nombre del técnico logueado.
//
// Autotask deja los datos del usuario en `window.walkMeData` (los alimenta al widget
// de WalkMe, pero los pone la propia página: userId, firstName, lastName,
// narrativeFullName, emailAddress...). El problema es DÓNDE los pone: en el `window`
// del main world de la página.
//
// entrypoints/content.ts corre en el "isolated world" — comparte el DOM con la página
// pero NO sus variables globales, así que ahí `window.walkMeData` es SIEMPRE undefined
// por más que la página la tenga poblada. (En la consola de DevTools sí se ve, porque
// el contexto "top" evalúa en el main world — de ahí la confusión: el dato está, pero
// del otro lado de la pared.)
//
// Este script sí corre en el main world, así que puede leerla; y como el DOM es lo
// único que ambos mundos comparten, deja el nombre en un data-attribute del <html>
// para que el content script lo levante. No usa chrome.* — en el main world no existen.
export default defineContentScript({
  matches: ['https://*.autotask.net/*'],
  // Solo Chrome/Edge: `world` no existe en Manifest V2, con el que se buildea Firefox.
  // Sin este include, WXT lo emitía igual en el manifest MV2 — una clave inválida que
  // AMO puede rechazar al firmar, y que Firefox ignora (dejando este script en el
  // isolated world, donde no ve nada). En Firefox la identidad se resuelve por
  // `wrappedJSObject` desde content.ts, que es el mecanismo equivalente allá.
  include: ['chrome', 'edge'],
  world: 'MAIN',
  runAt: 'document_idle',
  main() {
    function publish(): boolean {
      // No accedemos a window.walkMeData directo: readNameFrom() valida la forma y
      // nunca lanza, aunque la página exponga los campos con un getter hostil.
      const name = readNameFrom((window as any).walkMeData);
      if (!name) return false;
      document.documentElement.dataset[IDENTITY_DATASET_KEY] = name;
      return true;
    }

    // walkMeData suele estar lista en document_idle, pero no siempre: Autotask es una
    // SPA y en cargas lentas la puebla después. La ventana de reintentos la define
    // lib/identity-bridge.ts y es la MISMA que espera content.ts — si este puente
    // siguiera publicando después de que el otro lado dejó de mirar, el nombre se
    // perdería hasta la siguiente navegación.
    if (publish()) return;
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (publish() || Date.now() - startedAt >= IDENTITY_PUBLISH_WINDOW_MS) {
        clearInterval(timer);
      }
    }, 1000);
  },
});
