import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { requireAdmin } from '../../middleware/auth.js';

const __moduleDirname = path.dirname(fileURLToPath(import.meta.url));
// server/src/modules/backup/ → 4 levels up → project root
const PROJECT_ROOT = path.resolve(__moduleDirname, '../../../../');
const DATA_DIR     = path.join(PROJECT_ROOT, 'data');
const RESTORE_TMP  = path.join(PROJECT_ROOT, '.restore-tmp');

// ─────────────────────────────────────────────────────────────────────────────

export async function backupRoutes(app: FastifyInstance) {

  // ── GET /api/backup/download ────────────────────────────────────────────────
  // Streams the entire data/ folder as a .tar.gz archive.
  app.get('/download', { preHandler: requireAdmin }, async (req, reply) => {
    const date     = new Date().toISOString().split('T')[0];
    const filename = `rpgspeak-backup-${date}.tar.gz`;

    app.log.info(`[backup] download requested by ${(req as any).user?.username}`);

    reply.header('Content-Type', 'application/gzip');
    reply.header('Content-Disposition', `attachment; filename="${filename}"`);
    reply.header('Transfer-Encoding', 'chunked');

    // tar -czf - -C <project_root> data
    // stdout is a Readable stream → Fastify will pipe it to the response
    const tar = spawn('tar', ['-czf', '-', '-C', PROJECT_ROOT, 'data'], {
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
  // Accepts a .tar.gz file, replaces data/ with its contents, restarts.
  app.post('/restore', { preHandler: requireAdmin }, async (req, reply) => {
    app.log.info(`[backup] restore requested by ${(req as any).user?.username}`);

    // Accept up to 4 GB — override the global 10 MB multipart limit
    const fileData = await req.file({ limits: { fileSize: 4 * 1024 * 1024 * 1024 } });

    if (!fileData) {
      return reply.status(400).send({ success: false, error: 'No se recibió ningún archivo.' });
    }

    // Validate content-type loosely (browsers might send application/octet-stream)
    const mime = fileData.mimetype ?? '';
    const name = fileData.filename ?? '';
    const looksLikeTarGz = mime.includes('gzip') || mime.includes('octet-stream') || name.endsWith('.tar.gz') || name.endsWith('.tgz');
    if (!looksLikeTarGz) {
      return reply.status(400).send({ success: false, error: 'El archivo debe ser un .tar.gz' });
    }

    // Clean up any leftover temp dir from a previous failed restore
    if (fs.existsSync(RESTORE_TMP)) {
      fs.rmSync(RESTORE_TMP, { recursive: true, force: true });
    }
    fs.mkdirSync(RESTORE_TMP, { recursive: true });

    const tmpArchive = path.join(RESTORE_TMP, 'backup.tar.gz');
    const tmpExtract = path.join(RESTORE_TMP, 'extracted');

    try {
      // 1. Save upload to temp file
      const buffer = await fileData.toBuffer();
      fs.writeFileSync(tmpArchive, buffer);

      // 2. Extract archive
      fs.mkdirSync(tmpExtract, { recursive: true });
      await new Promise<void>((resolve, reject) => {
        const tar = spawn('tar', ['-xzf', tmpArchive, '-C', tmpExtract], {
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

      // 3. The archive must contain a top-level "data/" folder
      const extractedData = path.join(tmpExtract, 'data');
      if (!fs.existsSync(extractedData) || !fs.statSync(extractedData).isDirectory()) {
        return reply.status(400).send({
          success: false,
          error: 'El archivo no contiene una carpeta data/ en la raíz. Asegúrate de usar un backup generado por rpgSpeak.',
        });
      }

      // 4. Atomically replace: rename current data/ → data.bak/, extracted → data/
      const dataBak = DATA_DIR + '.bak';
      if (fs.existsSync(dataBak)) fs.rmSync(dataBak, { recursive: true, force: true });

      fs.renameSync(DATA_DIR, dataBak);
      try {
        fs.renameSync(extractedData, DATA_DIR);
      } catch (renameErr) {
        // renameSync can fail across filesystems — fall back to cpSync
        fs.renameSync(dataBak, DATA_DIR); // restore original
        fs.cpSync(extractedData, DATA_DIR, { recursive: true, force: true });
      }

      // 5. Remove backup copy and temp dir
      try { fs.rmSync(dataBak,   { recursive: true, force: true }); } catch {}
      try { fs.rmSync(RESTORE_TMP, { recursive: true, force: true }); } catch {}

      app.log.info('[backup] Restore successful');

      // En Docker (/.dockerenv existe o COOLIFY_RESOURCE_UUID está presente)
      // NO llamamos process.exit() porque el contenedor moriría antes de enviar
      // la respuesta HTTP, dejando al cliente esperando eternamente.
      // En PM2 (bare metal / VPS) sí reiniciamos para que PM2 recargue con los nuevos datos.
      const isDocker = fs.existsSync('/.dockerenv') || !!process.env.COOLIFY_RESOURCE_UUID;

      if (isDocker) {
        app.log.info('[backup] Docker detected — not calling process.exit(), restart container manually');
        return reply.send({
          success: true,
          message: 'Restauración completada. Reinicia el contenedor desde Coolify para que los cambios tengan efecto.',
          requiresRestart: true,
        });
      }

      // PM2: enviar respuesta y luego reiniciar el proceso
      void reply.send({ success: true, message: 'Restauración completada. El servidor se reiniciará en 1 segundo.', requiresRestart: false });
      setTimeout(() => process.exit(0), 1000);

    } catch (err) {
      // Clean up temp on failure
      try { fs.rmSync(RESTORE_TMP, { recursive: true, force: true }); } catch {}
      app.log.error({ err }, '[backup] Restore failed');
      return reply.status(500).send({
        success: false,
        error: err instanceof Error ? err.message : 'Error desconocido durante la restauración.',
      });
    }
  });
}
