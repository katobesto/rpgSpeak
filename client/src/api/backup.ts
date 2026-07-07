import { getAuthHeader } from './client.ts';

/** Progreso reportado a la UI, con fase para etiquetar la barra. */
export interface BackupProgress {
  phase: 'preparing' | 'downloading' | 'uploading' | 'restoring';
  /** 0-100 cuando se conoce el total; null en fases indeterminadas. */
  pct: number | null;
  /** Bytes transferidos hasta ahora (para mostrar MB en fases sin %). */
  bytes?: number;
  total?: number;
}

const DL_CHUNK = 25 * 1024 * 1024; // 25 MB por trozo de descarga
const UP_CHUNK = 50 * 1024 * 1024; // 50 MB por trozo de subida (< 100 MB del proxy)
const POLL_MS  = 1000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function jsonOrThrow(resp: Response, ctx: string): Promise<Record<string, unknown>> {
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({})) as Record<string, unknown>;
    throw new Error(String(err.error ?? `${ctx}: error ${resp.status}`));
  }
  return await resp.json() as Record<string, unknown>;
}

export const backupApi = {
  /**
   * Descarga el backup en tres fases robustas ante proxies con timeout:
   *   1. prepare  — el servidor genera el .tar.gz en un temporal (bg).
   *   2. polling  — se sondea el progreso de la generación.
   *   3. chunks   — se descarga por rangos de bytes (peticiones cortas) con %.
   * Ensambla un blob y devuelve { filename, url }. `includeImages=false` produce
   * un backup ligero solo con la base de datos.
   */
  async download(
    includeImages = true,
    onProgress?: (p: BackupProgress) => void,
  ): Promise<{ filename: string; url: string }> {
    // 1. prepare
    const prep = await jsonOrThrow(
      await fetch('/api/backup/prepare', {
        method: 'POST',
        headers: { ...getAuthHeader(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ includeImages }),
      }),
      'Preparar backup',
    );
    const jobId = String(prep.jobId);

    // 2. polling de la preparación
    let size = 0;
    let filename = `rpgspeak-backup${includeImages ? '' : '-sin-imagenes'}.tar.gz`;
    for (;;) {
      const st = await jsonOrThrow(
        await fetch(`/api/backup/prepare-status?jobId=${encodeURIComponent(jobId)}`, { headers: { ...getAuthHeader() } }),
        'Estado de preparación',
      );
      if (typeof st.filename === 'string') filename = st.filename;
      if (st.state === 'error') throw new Error(String(st.error ?? 'Error al preparar el backup.'));
      if (st.state === 'ready') { size = Number(st.size ?? 0); break; }
      onProgress?.({ phase: 'preparing', pct: null, bytes: Number(st.bytes ?? 0) });
      await sleep(POLL_MS);
    }

    if (size === 0) throw new Error('El backup preparado está vacío.');

    // 3. descarga por trozos
    const parts: Uint8Array[] = [];
    let received = 0;
    try {
      for (let start = 0; start < size; start += DL_CHUNK) {
        const end = Math.min(start + DL_CHUNK, size);
        const resp = await fetch(
          `/api/backup/download-chunk?jobId=${encodeURIComponent(jobId)}&start=${start}&end=${end}`,
          { headers: { ...getAuthHeader() } },
        );
        if (!resp.ok) {
          const err = await resp.json().catch(() => ({})) as Record<string, unknown>;
          throw new Error(String(err.error ?? `Error al descargar (bytes ${start}-${end})`));
        }
        parts.push(new Uint8Array(await resp.arrayBuffer()));
        received = end;
        onProgress?.({ phase: 'downloading', pct: Math.round((received / size) * 100), bytes: received, total: size });
      }
    } finally {
      // Limpia el temporal del servidor pase lo que pase (best-effort).
      void fetch('/api/backup/download-cleanup', {
        method: 'POST',
        headers: { ...getAuthHeader(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId }),
      }).catch(() => {});
    }

    const blob = new Blob(parts as BlobPart[], { type: 'application/gzip' });
    return { filename, url: URL.createObjectURL(blob) };
  },

  /**
   * Restaura un backup en dos fases robustas:
   *   1. upload  — se sube por trozos de 50 MB (con %).
   *   2. commit  — el servidor ensambla + extrae en segundo plano; se sondea el
   *      estado (la extracción de cientos de MB tardaría demasiado para una sola
   *      petición → timeout). Devuelve requiresRestart cuando corre en Docker.
   */
  async restore(
    file: File,
    onProgress?: (p: BackupProgress) => void,
  ): Promise<{ requiresRestart: boolean; message: string }> {
    const totalChunks = Math.ceil(file.size / UP_CHUNK);
    const uploadId    = crypto.randomUUID();

    // 1. subida por trozos
    for (let i = 0; i < totalChunks; i++) {
      const start = i * UP_CHUNK;
      const chunk = file.slice(start, Math.min(start + UP_CHUNK, file.size));
      const form  = new FormData();
      form.append('chunk', chunk, file.name);

      const resp = await fetch(
        `/api/backup/restore-chunk?uploadId=${encodeURIComponent(uploadId)}&chunkIndex=${i}&totalChunks=${totalChunks}`,
        { method: 'POST', headers: { ...getAuthHeader() }, body: form },
      );
      await jsonOrThrow(resp, `Subir chunk ${i + 1}/${totalChunks}`);
      onProgress?.({ phase: 'uploading', pct: Math.round(((i + 1) / totalChunks) * 100), bytes: Math.min(start + UP_CHUNK, file.size), total: file.size });
    }

    // 2. commit + polling de la restauración
    const commit = await jsonOrThrow(
      await fetch('/api/backup/restore-commit', {
        method: 'POST',
        headers: { ...getAuthHeader(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ uploadId, totalChunks }),
      }),
      'Iniciar restauración',
    );
    const jobId = String(commit.jobId);

    // El servidor solo se reinicia (PM2) DESPUÉS de que performRestore haya
    // tenido éxito. Por eso, si el estado desaparece (404 o conexión caída) tras
    // haber estado sondeando, significa que reinició al aplicar → éxito. Sin este
    // margen, un 404 permanente (mapa de trabajos vacío tras reinicio) haría un
    // bucle infinito. Un fallo aislado se reintenta; varios seguidos = reinicio.
    let consecutiveFailures = 0;
    const FAILURE_THRESHOLD = 6; // ~6 s sin estado → asumimos reinicio post-restore
    const restartedMsg = { requiresRestart: false, message: 'Restauración completada. El servidor se ha reiniciado.' };

    for (;;) {
      onProgress?.({ phase: 'restoring', pct: null });
      await sleep(POLL_MS);

      // Fase 1: obtener el estado. Los fallos de red / 404 (servidor reiniciándose
      // tras aplicar) se cuentan; varios seguidos = reinicio post-restore = éxito.
      let st: Record<string, unknown> | null = null;
      try {
        const resp = await fetch(`/api/backup/restore-status?jobId=${encodeURIComponent(jobId)}`, { headers: { ...getAuthHeader() } });
        if (resp.ok) st = await resp.json() as Record<string, unknown>;
      } catch { /* red caída → tratado abajo como fallo */ }

      if (!st) {
        if (++consecutiveFailures >= FAILURE_THRESHOLD) return restartedMsg;
        continue;
      }
      consecutiveFailures = 0;

      // Fase 2: interpretar el estado (el error de restore SÍ debe propagarse).
      if (st.state === 'error') throw new Error(String(st.error ?? 'Error al restaurar.'));
      if (st.state === 'ready') {
        return { requiresRestart: Boolean(st.requiresRestart), message: String(st.message ?? 'Restauración completada.') };
      }
    }
  },
};
