import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { requireAdmin } from '../../middleware/auth.js';

const __moduleDirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__moduleDirname, '../../../../');
const DATA_DIR     = path.join(PROJECT_ROOT, 'data');
const RESTORE_TMP  = path.join(PROJECT_ROOT, '.restore-tmp');
const CHUNKS_DIR   = path.join(PROJECT_ROOT, '.restore-chunks');
const DOWNLOAD_TMP = path.join(PROJECT_ROOT, '.backup-download-tmp');

// Los backups grandes (cientos de MB) no pueden viajar en una sola petición:
// el proxy (Cloudflare/Coolify) corta conexiones largas y el navegador no da
// feedback. Por eso descarga y restauración se hacen por TRABAJOS asíncronos +
// sondeo de estado + transferencia por trozos con rango. El registro de trabajos
// vive en memoria (un solo proceso; se pierde al reiniciar, lo cual es correcto:
// un backup a medio preparar no debe sobrevivir a un reinicio).

const JOB_TTL_MS = 60 * 60 * 1000; // 1 h — barrido de temporales huérfanos

interface PrepareJob {
  state: 'running' | 'ready' | 'error';
  filePath: string;
  filename: string;
  size: number;      // bytes finales (state 'ready')
  error?: string;
  createdAt: number;
}
interface RestoreJob {
  state: 'running' | 'ready' | 'error';
  requiresRestart?: boolean;
  message?: string;
  error?: string;
  createdAt: number;
}
const prepareJobs = new Map<string, PrepareJob>();
const restoreJobs = new Map<string, RestoreJob>();

/** Borra ficheros temporales y trabajos cuya antigüedad supera el TTL. */
function sweepStaleJobs(): void {
  const now = Date.now();
  for (const [id, job] of prepareJobs) {
    if (now - job.createdAt > JOB_TTL_MS) {
      try { if (fs.existsSync(job.filePath)) fs.rmSync(job.filePath, { force: true }); } catch { /* ignore */ }
      prepareJobs.delete(id);
    }
  }
  for (const [id, job] of restoreJobs) {
    if (now - job.createdAt > JOB_TTL_MS) restoreJobs.delete(id);
  }
  // Ficheros de descarga huérfanos (sin trabajo asociado) más viejos que el TTL
  try {
    if (fs.existsSync(DOWNLOAD_TMP)) {
      for (const f of fs.readdirSync(DOWNLOAD_TMP)) {
        const p = path.join(DOWNLOAD_TMP, f);
        try {
          if (now - fs.statSync(p).mtimeMs > JOB_TTL_MS) fs.rmSync(p, { force: true });
        } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
}

// ── Shared restore logic (extrae y reemplaza data/) ───────────────────────────
// Devuelve si el proceso debe reiniciarse (PM2) — el CALLER programa el exit,
// para poder marcar el trabajo como 'ready' antes de que el proceso muera.
async function performRestore(archivePath: string, app: FastifyInstance): Promise<{ requiresRestart: boolean; message: string; willRestart: boolean }> {
  const tmpExtract = path.join(RESTORE_TMP, 'extracted');

  if (fs.existsSync(RESTORE_TMP)) fs.rmSync(RESTORE_TMP, { recursive: true, force: true });
  fs.mkdirSync(tmpExtract, { recursive: true });

  // Extract
  await new Promise<void>((resolve, reject) => {
    const tar = spawn('tar', ['-xzf', archivePath, '-C', tmpExtract], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    const errLines: string[] = [];
    tar.stderr?.on('data', (c: Buffer) => errLines.push(c.toString().trim()));
    tar.on('error', reject);
    tar.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`tar exited ${code}: ${errLines.join(' ')}`));
    });
  });

  const extractedData = path.join(tmpExtract, 'data');
  if (!fs.existsSync(extractedData) || !fs.statSync(extractedData).isDirectory()) {
    fs.rmSync(RESTORE_TMP, { recursive: true, force: true });
    throw new Error('El archivo no contiene una carpeta data/ en la raíz.');
  }

  // Copy extracted files over the existing data/ directory.
  // We avoid renaming data/ itself because in Docker it can be a volume
  // mount point (EBUSY) and SQLite WAL keeps .db-shm/.db-wal open.
  // cpSync with force:true overwrites all files; extra files not in the
  // backup are left in place (harmless for a restore scenario).
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.cpSync(extractedData, DATA_DIR, { recursive: true, force: true });

  try { fs.rmSync(RESTORE_TMP, { recursive: true, force: true }); } catch { /* ignore */ }

  app.log.info('[backup] Restore successful');

  const isDocker = fs.existsSync('/.dockerenv') || !!process.env.COOLIFY_RESOURCE_UUID;
  if (isDocker) {
    return { requiresRestart: true, willRestart: false, message: 'Restauración completada. Reinicia el contenedor desde Coolify para aplicar los cambios.' };
  }
  return { requiresRestart: false, willRestart: true, message: 'Restauración completada. El servidor se reiniciará en unos segundos.' };
}

/** Ensambla los chunks (chunk-0..chunk-N) en un solo archivo por APPEND en
 *  streaming — nunca carga el backup entero en RAM (evita el pico de ~2×tamaño
 *  del antiguo Buffer.concat). */
function assembleChunks(uploadDir: string, total: number, outPath: string): void {
  if (fs.existsSync(outPath)) fs.rmSync(outPath, { force: true });
  const out = fs.openSync(outPath, 'w');
  try {
    for (let i = 0; i < total; i++) {
      const p = path.join(uploadDir, `chunk-${i}`);
      if (!fs.existsSync(p)) throw new Error(`Chunk ${i} no encontrado — la subida puede haberse interrumpido`);
      const fd = fs.openSync(p, 'r');
      try {
        const buf = Buffer.allocUnsafe(1024 * 1024); // 1 MB de ventana
        let bytesRead: number;
        while ((bytesRead = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
          fs.writeSync(out, buf, 0, bytesRead);
        }
      } finally {
        fs.closeSync(fd);
      }
    }
  } finally {
    fs.closeSync(out);
  }
}

// ─────────────────────────────────────────────────────────────────────────────

export async function backupRoutes(app: FastifyInstance) {

  // ── POST /api/backup/prepare ────────────────────────────────────────────────
  // Inicia la creación del .tar.gz en un fichero temporal (en segundo plano) y
  // devuelve un jobId. El cliente sondea el estado y luego descarga por trozos.
  app.post('/prepare', { preHandler: requireAdmin }, async (req, reply) => {
    sweepStaleJobs();
    const { includeImages } = (req.body ?? {}) as { includeImages?: boolean };
    const excludeImages = includeImages === false;

    const date     = new Date().toISOString().split('T')[0];
    const filename = `rpgspeak-backup-${date}${excludeImages ? '-sin-imagenes' : ''}.tar.gz`;
    const jobId    = randomUUID();
    const filePath = path.join(DOWNLOAD_TMP, `${jobId}.tar.gz`);

    fs.mkdirSync(DOWNLOAD_TMP, { recursive: true });

    const job: PrepareJob = { state: 'running', filePath, filename, size: 0, createdAt: Date.now() };
    prepareJobs.set(jobId, job);

    // tar -czf <file> -C <root> [--exclude=data/images] data
    const tarArgs = ['-czf', filePath, '-C', PROJECT_ROOT];
    if (excludeImages) tarArgs.push('--exclude=data/images');
    tarArgs.push('data');

    app.log.info(`[backup] prepare ${jobId} (imágenes: ${excludeImages ? 'excluidas' : 'incluidas'})`);

    const tar = spawn('tar', tarArgs, { stdio: ['ignore', 'ignore', 'pipe'] });
    const errLines: string[] = [];
    tar.stderr.on('data', (c: Buffer) => errLines.push(c.toString().trim()));
    tar.on('error', (err) => {
      job.state = 'error';
      job.error = err.message;
      app.log.error({ err }, '[backup] prepare tar spawn error');
    });
    tar.on('close', (code) => {
      if (job.state === 'error') return;
      if (code === 0 && fs.existsSync(filePath)) {
        job.size  = fs.statSync(filePath).size;
        job.state = 'ready';
        app.log.info(`[backup] prepare ${jobId} listo — ${(job.size / 1024 / 1024).toFixed(1)} MB`);
      } else {
        job.state = 'error';
        job.error = `tar salió con código ${code}: ${errLines.join(' ')}`;
        app.log.error(`[backup] prepare ${jobId} falló: ${job.error}`);
      }
    });

    return reply.send({ success: true, jobId });
  });

  // ── GET /api/backup/prepare-status ──────────────────────────────────────────
  // Estado del trabajo de preparación. `bytes` = tamaño actual del fichero
  // mientras se genera (progreso de la fase de preparación).
  app.get('/prepare-status', { preHandler: requireAdmin }, async (req, reply) => {
    const { jobId } = req.query as { jobId?: string };
    const job = jobId ? prepareJobs.get(jobId) : undefined;
    if (!job) return reply.status(404).send({ success: false, error: 'Trabajo no encontrado o expirado.' });

    let bytes = job.size;
    if (job.state === 'running') {
      try { bytes = fs.existsSync(job.filePath) ? fs.statSync(job.filePath).size : 0; } catch { bytes = 0; }
    }
    return reply.send({
      success: true,
      state:   job.state,
      bytes,
      size:    job.state === 'ready' ? job.size : undefined,
      filename: job.filename,
      error:   job.error,
    });
  });

  // ── GET /api/backup/download-chunk ──────────────────────────────────────────
  // Envía el rango de bytes [start, end) del backup ya preparado. Cada petición
  // es corta → no hay una única conexión larga que el proxy pueda cortar.
  app.get('/download-chunk', { preHandler: requireAdmin }, async (req, reply) => {
    const { jobId, start, end } = req.query as { jobId?: string; start?: string; end?: string };
    const job = jobId ? prepareJobs.get(jobId) : undefined;
    if (!job || job.state !== 'ready') {
      return reply.status(404).send({ success: false, error: 'Backup no disponible (aún no preparado o expirado).' });
    }
    const startByte = Math.max(0, parseInt(start ?? '0', 10) || 0);
    const endByte   = Math.min(job.size, parseInt(end ?? String(job.size), 10) || job.size);
    if (startByte >= endByte || startByte >= job.size) {
      return reply.status(416).send({ success: false, error: 'Rango inválido.' });
    }

    reply.header('Content-Type', 'application/octet-stream');
    reply.header('Content-Length', String(endByte - startByte));
    // createReadStream: `end` es INCLUSIVO
    return reply.send(fs.createReadStream(job.filePath, { start: startByte, end: endByte - 1 }));
  });

  // ── POST /api/backup/download-cleanup ───────────────────────────────────────
  // El cliente lo llama al terminar (o cancelar) para borrar el temporal ya.
  app.post('/download-cleanup', { preHandler: requireAdmin }, async (req, reply) => {
    const { jobId } = (req.body ?? {}) as { jobId?: string };
    const job = jobId ? prepareJobs.get(jobId) : undefined;
    if (job) {
      try { if (fs.existsSync(job.filePath)) fs.rmSync(job.filePath, { force: true }); } catch { /* ignore */ }
      prepareJobs.delete(jobId!);
    }
    return reply.send({ success: true });
  });

  // ── POST /api/backup/restore ────────────────────────────────────────────────
  // Compat: archivos pequeños en una sola petición (sin chunking).
  app.post('/restore', { preHandler: requireAdmin }, async (req, reply) => {
    const fileData = await req.file({ limits: { fileSize: 4 * 1024 * 1024 * 1024 } });
    if (!fileData) return reply.status(400).send({ success: false, error: 'No se recibió ningún archivo.' });

    const tmpArchive = path.join(RESTORE_TMP, 'backup.tar.gz');
    if (fs.existsSync(RESTORE_TMP)) fs.rmSync(RESTORE_TMP, { recursive: true, force: true });
    fs.mkdirSync(RESTORE_TMP, { recursive: true });

    try {
      fs.writeFileSync(tmpArchive, await fileData.toBuffer());
      const result = await performRestore(tmpArchive, app);
      void reply.send({ success: true, requiresRestart: result.requiresRestart, message: result.message });
      if (result.willRestart) setTimeout(() => process.exit(0), 1000);
    } catch (err) {
      try { fs.rmSync(RESTORE_TMP, { recursive: true, force: true }); } catch { /* ignore */ }
      app.log.error({ err }, '[backup] Restore failed');
      return reply.status(500).send({ success: false, error: err instanceof Error ? err.message : 'Error desconocido.' });
    }
  });

  // ── POST /api/backup/restore-chunk ─────────────────────────────────────────
  // Sube el backup por trozos de ~50 MB (esquiva el límite de 100 MB del proxy).
  // Cada chunk se guarda; NO se restaura aquí. El cliente llama a /restore-commit
  // al terminar. Query: uploadId, chunkIndex, totalChunks.
  app.post('/restore-chunk', { preHandler: requireAdmin }, async (req, reply) => {
    const { uploadId, chunkIndex, totalChunks } = req.query as {
      uploadId: string; chunkIndex: string; totalChunks: string;
    };
    if (!uploadId || chunkIndex === undefined || !totalChunks) {
      return reply.status(400).send({ success: false, error: 'Faltan parámetros: uploadId, chunkIndex, totalChunks' });
    }
    const idx   = parseInt(chunkIndex, 10);
    const total = parseInt(totalChunks, 10);
    if (isNaN(idx) || isNaN(total) || idx < 0 || idx >= total) {
      return reply.status(400).send({ success: false, error: 'Parámetros de chunk inválidos' });
    }

    const fileData = await req.file({ limits: { fileSize: 60 * 1024 * 1024 } });
    if (!fileData) return reply.status(400).send({ success: false, error: 'No se recibió chunk' });

    const uploadDir = path.join(CHUNKS_DIR, uploadId);
    const chunkPath = path.join(uploadDir, `chunk-${idx}`);
    try {
      fs.mkdirSync(uploadDir, { recursive: true });
      fs.writeFileSync(chunkPath, await fileData.toBuffer());
      app.log.info(`[backup] chunk ${idx + 1}/${total} recibido (uploadId=${uploadId})`);
      return reply.send({ success: true, received: idx + 1, total });
    } catch (err) {
      app.log.error({ err }, '[backup] Restore chunk failed');
      return reply.status(500).send({ success: false, error: err instanceof Error ? err.message : 'Error desconocido.' });
    }
  });

  // ── POST /api/backup/restore-commit ─────────────────────────────────────────
  // Ensambla los chunks y restaura, en SEGUNDO PLANO (la extracción de cientos
  // de MB tardaría demasiado para una sola petición → timeout de proxy). Devuelve
  // un jobId; el cliente sondea /restore-status.
  app.post('/restore-commit', { preHandler: requireAdmin }, async (req, reply) => {
    const { uploadId, totalChunks } = (req.body ?? {}) as { uploadId?: string; totalChunks?: number };
    if (!uploadId || !totalChunks || totalChunks < 1) {
      return reply.status(400).send({ success: false, error: 'Faltan parámetros: uploadId, totalChunks' });
    }
    const uploadDir = path.join(CHUNKS_DIR, uploadId);
    if (!fs.existsSync(uploadDir)) {
      return reply.status(404).send({ success: false, error: 'Subida no encontrada o expirada.' });
    }

    const jobId = randomUUID();
    const job: RestoreJob = { state: 'running', createdAt: Date.now() };
    restoreJobs.set(jobId, job);

    // Ejecuta en bg; la respuesta vuelve ya con el jobId.
    void (async () => {
      const assembledPath = path.join(uploadDir, 'backup.tar.gz');
      try {
        app.log.info(`[backup] restore-commit ${jobId}: ensamblando ${totalChunks} chunks…`);
        assembleChunks(uploadDir, totalChunks, assembledPath);
        const result = await performRestore(assembledPath, app);
        try { fs.rmSync(uploadDir, { recursive: true, force: true }); } catch { /* ignore */ }
        job.state = 'ready';
        job.requiresRestart = result.requiresRestart;
        job.message = result.message;
        app.log.info(`[backup] restore-commit ${jobId}: OK`);
        // Reinicio PM2 diferido: da margen a que el cliente lea 'ready'.
        if (result.willRestart) setTimeout(() => process.exit(0), 4000);
      } catch (err) {
        try { fs.rmSync(uploadDir, { recursive: true, force: true }); } catch { /* ignore */ }
        job.state = 'error';
        job.error = err instanceof Error ? err.message : 'Error desconocido.';
        app.log.error({ err }, `[backup] restore-commit ${jobId} falló`);
      }
    })();

    return reply.send({ success: true, jobId });
  });

  // ── GET /api/backup/restore-status ──────────────────────────────────────────
  app.get('/restore-status', { preHandler: requireAdmin }, async (req, reply) => {
    const { jobId } = req.query as { jobId?: string };
    const job = jobId ? restoreJobs.get(jobId) : undefined;
    if (!job) return reply.status(404).send({ success: false, error: 'Trabajo no encontrado o expirado.' });
    return reply.send({
      success: true,
      state:   job.state,
      requiresRestart: job.requiresRestart,
      message: job.message,
      error:   job.error,
    });
  });
}
