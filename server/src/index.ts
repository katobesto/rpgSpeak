import { buildApp } from './app.js';
import { config } from './config.js';
import { initDb } from './db/index.js';
import { runMigrations } from './db/migrations.js';
import fs from 'fs';
import path from 'path';

async function main() {
  // Ensure data directory exists
  const dataDir = path.dirname(config.db.path);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  // Initialize database
  const db = initDb(config.db.path);
  runMigrations(db);

  const app = await buildApp();

  try {
    await app.listen({ port: config.server.port, host: config.server.host });
    app.log.info(`rpgSpeak running at http://${config.server.host}:${config.server.port}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();
