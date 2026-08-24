// Puente al "main world" de la página, para leer el nombre del técnico logueado.
//
// Autotask deja los datos del usuario en `window.walkMeData` (los alimenta al
// widget de WalkMe, pero los pone la propia página: userId, firstName, lastName,
// narrativeFullName, emailAddress...). El problema es DÓNDE los pone: en el
// `window` del main world de la página.
//
// entrypoints/content.ts corre en el "isolated world" — comparte el DOM con la
// página pero NO sus variables globales, así que ahí `window.walkMeData` es
// SIEMPRE undefined por más que la página la tenga poblada. (En la consola de
// DevTools sí se ve, porque el contexto "top" evalúa en el main world — de ahí
// la confusión: el dato está, pero del otro lado de la pared.)
//
// Este script sí corre en el main world, así que puede leerla; y como el DOM es
// lo único que ambos mundos comparten, deja el nombre en un data-attribute del
// <html> para que el content script lo levante. No usa chrome.* — en el main
// world no existen.
export default defineContentScript({
  matches: ['https://*.autotask.net/*'],
  world: 'MAIN',
  runAt: 'document_idle',
  main() {
    // Debe coincidir con el que lee getUserFromDOM() en content.ts.
    // dataset.netsusCoviewUser <-> atributo data-netsus-coview-user
    const DATASET_KEY = 'netsusCoviewUser';

    function readName(): string | null {
      try {
        const wmd = (window as any).walkMeData;
        if (!wmd) return null;
        if (typeof wmd.narrativeFullName === 'string' && wmd.narrativeFullName.trim()) {
          return wmd.narrativeFullName.trim();
        }
        if (wmd.firstName && wmd.lastName) {
          return `${wmd.firstName} ${wmd.lastName}`.trim();
        }
      } catch {
        // La página podría tener un getter que tire — nunca romper por esto.
      }
      return null;
    }

    function publish(): boolean {
      const name = readName();
      if (!name) return false;
      document.documentElement.dataset[DATASET_KEY] = name;
      return true;
    }

    // walkMeData suele estar lista en document_idle, pero no siempre: Autotask es
    // una SPA y en cargas lentas la puebla después. Reintentamos por ~20s y paramos
    // (el content script tiene su propio reintento en paralelo, ver loadUserAndInit).
    if (publish()) return;
    let tries = 0;
    const timer = setInterval(() => {
      if (publish() || ++tries >= 20) clearInterval(timer);
    }, 1000);
  },
});
