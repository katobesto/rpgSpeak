import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { requireAdmin } from '../../middleware/auth.js';

const __moduleDirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__moduleDirname, '../../../../');
const DATA_DIR     = path.join(PROJECT_ROOT, 'data');
const RESTORE_TMP  = path.join(PROJECT_ROOT, '.restore-tmp');
const CHUNKS_DIR   = path.join(PROJECT_ROOT, '.restore-chunks');

// ── Shared restore logic (used by both single-upload and chunked) ─────────────
async function performRestore(archivePath: string, app: FastifyInstance): Promise<{ requiresRestart: boolean; message: string }> {
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

  try { fs.rmSync(RESTORE_TMP, { recursive: true, force: true }); } catch {}

  app.log.info('[backup] Restore successful');

  const isDocker = fs.existsSync('/.dockerenv') || !!process.env.COOLIFY_RESOURCE_UUID;
  if (isDocker) {
    return { requiresRestart: true, message: 'Restauración completada. Reinicia el contenedor desde Coolify para aplicar los cambios.' };
  }

  // PM2: schedule exit so PM2 restarts the process
  setTimeout(() => process.exit(0), 1000);
  return { requiresRestart: false, message: 'Restauración completada. El servidor se reiniciará en 1 segundo.' };
}

// ─────────────────────────────────────────────────────────────────────────────

export async function backupRoutes(app: FastifyInstance) {

  // ── GET /api/backup/download ────────────────────────────────────────────────
  // Streams the data/ folder as a .tar.gz archive.
  // Query: includeImages=false → excluye data/images (que puede pesar cientos de
  // MB y hacer inviable la descarga; el cliente la bufferiza en un blob). Sin
  // imágenes el backup es solo la BD + workflows + TTS (unos MB), rápido y fiable.
  app.get('/download', { preHandler: requireAdmin }, async (req, reply) => {
    const { includeImages } = req.query as { includeImages?: string };
    const excludeImages = includeImages === 'false';

    const date     = new Date().toISOString().split('T')[0];
    const filename = `rpgspeak-backup-${date}${excludeImages ? '-sin-imagenes' : ''}.tar.gz`;

    app.log.info(`[backup] download requested by ${(req as any).user?.username} (imágenes: ${excludeImages ? 'excluidas' : 'incluidas'})`);

    reply.header('Content-Type', 'application/gzip');
    reply.header('Content-Disposition', `attachment; filename="${filename}"`);
    reply.header('Transfer-Encoding', 'chunked');

    // tar -czf - -C <project_root> [--exclude=data/images] data
    // El --exclude va ANTES del operando `data` (obligatorio en BSD tar/macOS;
    // GNU tar lo acepta en cualquier posición). Excluye el subárbol completo.
    const tarArgs = ['-czf', '-', '-C', PROJECT_ROOT];
    if (excludeImages) tarArgs.push('--exclude=data/images');
    tarArgs.push('data');

    // stdout is a Readable stream → Fastify will pipe it to the response
    const tar = spawn('tar', tarArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    tar.stderr.on('data', (chunk: Buffer) => {
      app.log.warn('[backup] tar stderr: ' + chunk.toString().trim());
    });

    tar.on('error', (err) => {
      app.log.error({ err }, '[backup] tar spawn error');
    });

    return reply.send(tar.stdout);
  });

  // ── POST /api/backup/restore ────────────────────────────────────────────────
  // Mantener por compatibilidad (archivos pequeños < 100MB sin chunking)
  app.post('/restore', { preHandler: requireAdmin }, async (req, reply) => {
    const fileData = await req.file({ limits: { fileSize: 4 * 1024 * 1024 * 1024 } });
    if (!fileData) return reply.status(400).send({ success: false, error: 'No se recibió ningún archivo.' });

    const tmpArchive = path.join(RESTORE_TMP, 'backup.tar.gz');
    if (fs.existsSync(RESTORE_TMP)) fs.rmSync(RESTORE_TMP, { recursive: true, force: true });
    fs.mkdirSync(RESTORE_TMP, { recursive: true });

    try {
      fs.writeFileSync(tmpArchive, await fileData.toBuffer());
      const result = await performRestore(tmpArchive, app);
      if (result.requiresRestart) return reply.send({ success: true, ...result });
      void reply.send({ success: true, ...result });
    } catch (err) {
      try { fs.rmSync(RESTORE_TMP, { recursive: true, force: true }); } catch {}
      app.log.error({ err }, '[backup] Restore failed');
      return reply.status(500).send({ success: false, error: err instanceof Error ? err.message : 'Error desconocido.' });
    }
  });

  // ── POST /api/backup/restore-chunk ─────────────────────────────────────────
  // Chunked upload para backups grandes (>100MB) que Cloudflare limitaría.
  // El cliente divide el archivo en trozos de 50MB y los sube uno a uno.
  // Query params: uploadId (string), chunkIndex (number), totalChunks (number)
  // En el último chunk el servidor ensambla y ejecuta el restore.
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

    // Each chunk max 60MB (well under Cloudflare's 100MB limit)
    const fileData = await req.file({ limits: { fileSize: 60 * 1024 * 1024 } });
    if (!fileData) return reply.status(400).send({ success: false, error: 'No se recibió chunk' });

    const uploadDir  = path.join(CHUNKS_DIR, uploadId);
    const chunkPath  = path.join(uploadDir, `chunk-${idx}`);

    try {
      fs.mkdirSync(uploadDir, { recursive: true });
      fs.writeFileSync(chunkPath, await fileData.toBuffer());

      app.log.info(`[backup] chunk ${idx + 1}/${total} recibido (uploadId=${uploadId})`);

      // Not the last chunk — just acknowledge
      if (idx < total - 1) {
        return reply.send({ success: true, received: idx + 1, total });
      }

      // ── Last chunk: assemble all chunks and restore ────────────────────────
      app.log.info(`[backup] Todos los chunks recibidos — ensamblando (uploadId=${uploadId})`);

      const assembledPath = path.join(uploadDir, 'backup.tar.gz');
      const buffers: Buffer[] = [];
      for (let i = 0; i < total; i++) {
        const p = path.join(uploadDir, `chunk-${i}`);
        if (!fs.existsSync(p)) {
          throw new Error(`Chunk ${i} no encontrado — la subida puede haberse interrumpido`);
        }
        buffers.push(fs.readFileSync(p));
      }
      fs.writeFileSync(assembledPath, Buffer.concat(buffers));

      const result = await performRestore(assembledPath, app);

      // Cleanup chunk dir
      try { fs.rmSync(uploadDir, { recursive: true, force: true }); } catch {}

      if (result.requiresRestart) {
        return reply.send({ success: true, ...result });
      }
      void reply.send({ success: true, ...result });

    } catch (err) {
      try { fs.rmSync(path.join(CHUNKS_DIR, uploadId), { recursive: true, force: true }); } catch {}
      app.log.error({ err }, '[backup] Restore chunk failed');
      return reply.status(500).send({ success: false, error: err instanceof Error ? err.message : 'Error desconocido.' });
    }
  });
}
