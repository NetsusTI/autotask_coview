// Contrato compartido entre los dos mundos que resuelven la identidad del técnico.
//
// El puente (entrypoints/walkme-bridge.content.ts) corre en el MAIN world y publica;
// el content script (entrypoints/content.ts) corre en el ISOLATED world y consume.
// No pueden compartir variables — solo el DOM — así que lo único que los une es el
// nombre del data-attribute y el tiempo que ambos acuerdan esperar. Tenerlo acá evita
// que se desincronicen: cuando estaban hardcodeados por separado, el puente reintentaba
// ~20 s y el consumidor dejaba de mirar a los ~16 s, así que un Autotask lento podía
// publicar el nombre en un momento en que ya nadie lo leía.

/**
 * Clave de `dataset` donde el puente publica el nombre.
 * `dataset.netsusCoviewUser` <-> atributo `data-netsus-coview-user`.
 */
export const IDENTITY_DATASET_KEY = 'netsusCoviewUser';

/**
 * Cuánto tiempo se insiste en resolver la identidad desde que carga la página.
 * Ambos lados usan este mismo presupuesto: el puente deja de publicar cuando se
 * agota, y el content script deja de sondear en ese mismo momento.
 */
export const IDENTITY_PUBLISH_WINDOW_MS = 25_000;

/** Cada cuánto vuelve a mirar el content script mientras dure la ventana. */
export const IDENTITY_POLL_INTERVAL_MS = 1_500;
