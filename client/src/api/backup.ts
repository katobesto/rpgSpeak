import { getAuthHeader } from './client.ts';

export const backupApi = {
  /**
   * Downloads the data/ folder as a .tar.gz archive.
   * Uses fetch (not a plain link) so the Authorization header is sent.
   * `includeImages=false` excluye data/images (que puede pesar cientos de MB y
   * hacer que el navegador no complete el blob). Returns { filename, url }.
   */
  async download(includeImages = true): Promise<{ filename: string; url: string }> {
    const date     = new Date().toISOString().split('T')[0];
    const filename = `rpgspeak-backup-${date}${includeImages ? '' : '-sin-imagenes'}.tar.gz`;

    const resp = await fetch(`/api/backup/download?includeImages=${includeImages}`, {
      method: 'GET',
      headers: { ...getAuthHeader() },
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({})) as Record<string, unknown>;
      throw new Error(String(err.error ?? `Error ${resp.status}`));
    }

    const blob = await resp.blob();
    const url  = URL.createObjectURL(blob);
    return { filename, url };
  },

  /**
   * Uploads a .tar.gz backup archive using chunked upload (50MB per chunk).
   * Bypasses Cloudflare's 100MB per-request body limit.
   * Returns requiresRestart=true when running in Docker.
   */
  async restore(
    file: File,
    onProgress?: (pct: number) => void,
  ): Promise<{ requiresRestart: boolean; message: string }> {
    const CHUNK_SIZE  = 50 * 1024 * 1024; // 50MB — safely under Cloudflare's 100MB limit
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
    const uploadId    = crypto.randomUUID();

    for (let i = 0; i < totalChunks; i++) {
      const start = i * CHUNK_SIZE;
      const end   = Math.min(start + CHUNK_SIZE, file.size);
      const chunk = file.slice(start, end);

      const form = new FormData();
      form.append('chunk', chunk, file.name);

      const url = `/api/backup/restore-chunk?uploadId=${encodeURIComponent(uploadId)}&chunkIndex=${i}&totalChunks=${totalChunks}`;

      const resp = await fetch(url, {
        method:  'POST',
        headers: { ...getAuthHeader() },
        body:    form,
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({})) as Record<string, unknown>;
        throw new Error(String(err.error ?? `Error en chunk ${i + 1}/${totalChunks} (${resp.status})`));
      }

      // Report progress (last chunk already at 100%)
      onProgress?.(Math.round(((i + 1) / totalChunks) * 100));

      // Last chunk returns the final restore result
      if (i === totalChunks - 1) {
        const data = await resp.json() as { success: boolean; message: string; requiresRestart: boolean };
        return { requiresRestart: data.requiresRestart ?? false, message: data.message };
      }
    }

    return { requiresRestart: false, message: 'Completado' };
  },
};
