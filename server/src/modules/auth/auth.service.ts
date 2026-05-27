import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import jwt from 'jsonwebtoken';
import { compareSync, hashSync } from 'bcryptjs';
import { sql } from 'drizzle-orm';
import { getDb } from '../../db/index.js';
import type { AuthPayload, User, UserRole } from '@rpgspeak/shared';

// ─── JWT secret — auto-generated on first run, persisted to disk ──────────────

function loadOrCreateSecret(dataDir: string): string {
  const secretPath = path.join(dataDir, 'jwt-secret.txt');
  if (fs.existsSync(secretPath)) {
    return fs.readFileSync(secretPath, 'utf8').trim();
  }
  const secret = randomBytes(48).toString('hex');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(secretPath, secret, { mode: 0o600 });
  return secret;
}

// Determine data dir: same logic as TTS server (relative to CWD / env var)
const DATA_DIR = process.env.DATA_DIR ?? path.resolve(process.cwd(), 'data');
const JWT_SECRET = process.env.JWT_SECRET ?? loadOrCreateSecret(DATA_DIR);
const JWT_EXPIRY = '30d';

// ─── Token helpers ────────────────────────────────────────────────────────────

export function signToken(payload: AuthPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRY });
}

export function verifyToken(token: string): AuthPayload {
  return jwt.verify(token, JWT_SECRET) as AuthPayload;
}

// ─── DB helpers ───────────────────────────────────────────────────────────────

interface DbUserRow {
  id: string;
  username: string;
  password_hash: string;
  display_name: string;
  appearance: string;
  avatar: string | null;
  role: string;
  is_active: number;
  created_at: string;
  updated_at: string;
}

function rowToUser(row: DbUserRow): User {
  return {
    id:          row.id,
    username:    row.username,
    displayName: row.display_name,
    appearance:  row.appearance ?? '',
    avatar:      row.avatar ?? null,
    role:        row.role as UserRole,
    isActive:    Boolean(row.is_active),
    createdAt:   row.created_at,
    updatedAt:   row.updated_at,
  };
}

// ─── Login ────────────────────────────────────────────────────────────────────

export function loginUser(username: string, password: string, fromLocalhost: boolean): {
  token: string;
  user: User;
} | null {
  const db = getDb();

  const row = db.get<DbUserRow>(
    sql`SELECT * FROM users WHERE username = ${username} AND is_active = 1`
  );
  if (!row) return null;

  const valid = compareSync(password, row.password_hash);
  if (!valid) return null;

  // Admin accounts can only log in from localhost
  if (row.role === 'admin' && !fromLocalhost) return null;

  const user = rowToUser(row);
  const payload: AuthPayload = {
    userId:      user.id,
    username:    user.username,
    role:        user.role,
    displayName: user.displayName,
    appearance:  user.appearance,
  };

  return { token: signToken(payload), user };
}

export function getUserById(id: string): User | null {
  const db = getDb();
  const row = db.get<DbUserRow>(sql`SELECT * FROM users WHERE id = ${id}`);
  return row ? rowToUser(row) : null;
}

/** @deprecated use updateProfile instead */
export function updateDisplayName(userId: string, displayName: string): { token: string; user: User } | null {
  return updateProfile(userId, { displayName });
}

export function updateProfile(
  userId: string,
  updates: { displayName?: string; appearance?: string },
): { token: string; user: User } | null {
  const db = getDb();
  const ts = new Date().toISOString();
  if (updates.displayName !== undefined) {
    db.run(sql`UPDATE users SET display_name = ${updates.displayName}, updated_at = ${ts} WHERE id = ${userId}`);
  }
  if (updates.appearance !== undefined) {
    db.run(sql`UPDATE users SET appearance = ${updates.appearance}, updated_at = ${ts} WHERE id = ${userId}`);
  }
  const user = getUserById(userId);
  if (!user) return null;
  const payload: AuthPayload = {
    userId:      user.id,
    username:    user.username,
    role:        user.role,
    displayName: user.displayName,
    appearance:  user.appearance,
  };
  return { token: signToken(payload), user };
}

export function updateAvatar(userId: string, avatarPath: string | null): { token: string; user: User } | null {
  const db = getDb();
  const ts = new Date().toISOString();
  db.run(sql`UPDATE users SET avatar = ${avatarPath}, updated_at = ${ts} WHERE id = ${userId}`);
  const user = getUserById(userId);
  if (!user) return null;
  const payload: AuthPayload = {
    userId:      user.id,
    username:    user.username,
    role:        user.role,
    displayName: user.displayName,
    appearance:  user.appearance,
  };
  return { token: signToken(payload), user };
}

export function changePassword(userId: string, currentPassword: string, newPassword: string): boolean {
  const db = getDb();
  const row = db.get<DbUserRow>(sql`SELECT * FROM users WHERE id = ${userId}`);
  if (!row) return false;

  const valid = compareSync(currentPassword, row.password_hash);
  if (!valid) return false;

  const newHash = hashSync(newPassword, 10);
  const ts = new Date().toISOString();
  db.run(sql`UPDATE users SET password_hash = ${newHash}, updated_at = ${ts} WHERE id = ${userId}`);
  return true;
}
