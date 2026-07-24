/** Nombres legibles de los mecanismos de fondo (etiquetas de bg-usage.ts del
 *  servidor). Compartido entre el badge de tokens y las estadísticas. */
export const BG_LABEL_NAMES: Record<string, string> = {
  'pre-analisis':      'Pre-análisis',
  'moderacion':        'Moderación',
  'analisis-fast':     'Análisis (fast LLM)',
  'resumen-bloque':    'Resumen de bloque',
  'resumen-arco':      'Resumen de arco',
  'resumen-personaje': 'Resumen personal',
  'anclaje-mundo':     'Anclaje del mundo',
  'reloj-mundo':       'Reloj del mundo',
  'director-escena':   'Director de escena',
  'hilo-fatal':        'Hilo fatal',
  'indice-contexto':   'Índice de contexto',
};
