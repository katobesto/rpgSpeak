import { getAuthHeader } from './client.ts';

export const backupApi = {
  /**
   * Downloads the full data/ folder as a .tar.gz archive.
   * Uses fetch (not a plain link) so the Authorization header is sent.
   * Returns a { filename, url } where url is a temporary blob URL.
   */
  async download(): Promise<{ filename: string; url: string }> {
    const date     = new Date().toISOString().split('T')[0];
    const filename = `rpgspeak-backup-${date}.tar.gz`;

    const resp = await fetch('/api/backup/download', {
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
   * Uploads a .tar.gz backup archive to replace data/ on the server.
   * Returns requiresRestart=true when running in Docker (no auto-restart).
   * Returns requiresRestart=false when running under PM2 (auto-restarts).
   */
  async restore(file: File): Promise<{ requiresRestart: boolean; message: string }> {
    const form = new FormData();
    form.append('backup', file);

    const resp = await fetch('/api/backup/restore', {
      method: 'POST',
      headers: { ...getAuthHeader() },
      body: form,
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({})) as Record<string, unknown>;
      throw new Error(String(err.error ?? `Error ${resp.status}`));
    }

    const data = await resp.json() as { success: boolean; message: string; requiresRestart: boolean };
    return { requiresRestart: data.requiresRestart ?? false, message: data.message };
  },
};
