import type { ServerResponse } from 'node:http';

// ── SSE: cabeceras + latido anti-corte de proxy ──────────────────────────────
//
// El despliegue real va detrás de Cloudflare (rpgspeak.javierbenzo.com) y de
// Caddy (Coolify). Cloudflare corta una conexión si el origen pasa 100 s sin
// mandarle bytes: responde 524 «A Timeout Occurred» y el cliente lo ve como
// `Stream error: 524`. Con prefills largos (contextos enormes, modelos locales
// lentos, razonamiento prolongado) pueden pasar varios minutos hasta el primer
// token, y ahí el stream se cae aunque el LLM siga trabajando.
//
// Ampliar timeouts del lado del servidor no lo arregla: el límite está en el
// borde de Cloudflare (100 s, no configurable fuera de Enterprise). Lo que sí lo
// arregla es que el origen responda al instante y mantenga la conexión con
// tráfico: comentarios SSE (`: ping`), que cualquier parser conforme —y el
// cliente de esta app, que solo lee líneas `data: `— ignora sin más.

/** Intervalo del latido. 15 s deja margen de sobra frente al corte de 100 s
 *  incluso si un ciclo se retrasa por carga, y cuesta ~4 bytes por latido. */
export const SSE_HEARTBEAT_MS = 15_000;

/** Escribe las cabeceras SSE y suelta el primer byte YA. `writeHead()` solo no
 *  basta: Node no emite nada hacia el cliente hasta el primer `write()`, y ese
 *  silencio inicial es justo lo que cuenta el proxy como origen mudo. */
export function startSse(res: ServerResponse): void {
  res.writeHead(200, {
    'Content-Type':      'text/event-stream',
    'Cache-Control':     'no-cache',
    'Connection':        'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  try { res.write(': open\n\n'); } catch { /* cliente ido antes de empezar */ }
}

/** Latido cada `everyMs` mientras la respuesta siga viva. Devuelve la función de
 *  parada: hay que llamarla SIEMPRE al terminar (en un `finally`), o el
 *  intervalo seguirá escribiendo sobre un socket cerrado. */
export function startSseHeartbeat(res: ServerResponse, everyMs: number = SSE_HEARTBEAT_MS): () => void {
  const timer = setInterval(() => {
    if (res.writableEnded || res.destroyed || !res.writable) return;
    try { res.write(': ping\n\n'); } catch { /* el cliente ya cerró */ }
  }, everyMs);
  return () => clearInterval(timer);
}
