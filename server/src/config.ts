import 'dotenv/config';
import path from 'path';
import { fileURLToPath } from 'url';

// Directorio de este archivo (server/src/) — independiente de process.cwd()
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Raíz del proyecto = dos niveles arriba de server/src/
const PROJECT_ROOT = path.resolve(__dirname, '../../');

function required(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required environment variable: ${key}`);
  return value;
}

function optional(key: string, defaultValue: string): string {
  return process.env[key] ?? defaultValue;
}

function optionalInt(key: string, defaultValue: number): number {
  const raw = process.env[key];
  if (!raw) return defaultValue;
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed)) throw new Error(`Environment variable ${key} must be an integer`);
  return parsed;
}

export const config = {
  server: {
    port: optionalInt('PORT', 3000),
    host: optional('HOST', 'localhost'),
    nodeEnv: optional('NODE_ENV', 'development'),
    isDev: optional('NODE_ENV', 'development') === 'development',
  },
  db: {
    // Si DB_PATH es absoluto, úsalo tal cual. Si es relativo o no está definido,
    // resuelve siempre desde la raíz del proyecto (no desde process.cwd()).
    path: process.env.DB_PATH
      ? path.resolve(process.env.DB_PATH)
      : path.join(PROJECT_ROOT, 'data', 'rpgspeak.db'),
  },
  logging: {
    level: optional('LOG_LEVEL', 'info') as 'trace' | 'debug' | 'info' | 'warn' | 'error',
  },
  cors: {
    origin: optional('CORS_ORIGIN', 'http://localhost:5173'),
  },
  limits: {
    maxContextTokens: optionalInt('MAX_CONTEXT_TOKENS', 8192),
    maxMessageLength: optionalInt('MAX_MESSAGE_LENGTH', 32768),
  },
  ollama: {
    baseUrl: optional('OLLAMA_BASE_URL', 'http://localhost:11434'),
  },
} as const;
