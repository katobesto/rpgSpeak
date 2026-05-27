import { sql } from 'drizzle-orm';
import { hashSync } from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../../db/index.js';
import type { User, UserRole, CreateUserDto, UpdateUserDto } from '@rpgspeak/shared';

interface DbUserRow {
  id: string;
  username: string;
  password_hash: string;
  display_name: string;
  appearance: string;
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
    role:        row.role as UserRole,
    isActive:    Boolean(row.is_active),
    createdAt:   row.created_at,
    updatedAt:   row.updated_at,
  };
}

function now() { return new Date().toISOString(); }

export class UserRepository {
  private get db() { return getDb(); }

  findAll(): User[] {
    const rows = this.db.all<DbUserRow>(sql`SELECT * FROM users ORDER BY created_at ASC`);
    return rows.map(rowToUser);
  }

  findById(id: string): User | null {
    const row = this.db.get<DbUserRow>(sql`SELECT * FROM users WHERE id = ${id}`);
    return row ? rowToUser(row) : null;
  }

  findByUsername(username: string): User | null {
    const row = this.db.get<DbUserRow>(sql`SELECT * FROM users WHERE username = ${username}`);
    return row ? rowToUser(row) : null;
  }

  create(dto: CreateUserDto): User {
    const id   = uuidv4();
    const ts   = now();
    const hash = hashSync(dto.password, 10);
    const appearance = dto.appearance ?? '';

    this.db.run(sql`
      INSERT INTO users (id, username, password_hash, display_name, appearance, role, is_active, created_at, updated_at)
      VALUES (${id}, ${dto.username}, ${hash}, ${dto.displayName}, ${appearance}, ${dto.role}, 1, ${ts}, ${ts})
    `);

    return this.findById(id)!;
  }

  update(id: string, dto: UpdateUserDto): User | null {
    const ts = now();

    if (dto.password !== undefined) {
      const hash = hashSync(dto.password, 10);
      this.db.run(sql`UPDATE users SET password_hash = ${hash}, updated_at = ${ts} WHERE id = ${id}`);
    }
    if (dto.displayName !== undefined) {
      this.db.run(sql`UPDATE users SET display_name = ${dto.displayName}, updated_at = ${ts} WHERE id = ${id}`);
    }
    if (dto.appearance !== undefined) {
      this.db.run(sql`UPDATE users SET appearance = ${dto.appearance}, updated_at = ${ts} WHERE id = ${id}`);
    }
    if (dto.role !== undefined) {
      this.db.run(sql`UPDATE users SET role = ${dto.role}, updated_at = ${ts} WHERE id = ${id}`);
    }

    return this.findById(id);
  }

  setActive(id: string, active: boolean): User | null {
    const ts = now();
    this.db.run(sql`UPDATE users SET is_active = ${active ? 1 : 0}, updated_at = ${ts} WHERE id = ${id}`);
    return this.findById(id);
  }

  delete(id: string): void {
    this.db.run(sql`DELETE FROM users WHERE id = ${id}`);
  }

  count(): number {
    const row = this.db.get<{ n: number }>(sql`SELECT count(*) as n FROM users`);
    return row?.n ?? 0;
  }

  // ─── Content assignment helpers ─────────────────────────────────────────────

  getAssignedCharacterIds(userId: string): string[] {
    const rows = this.db.all<{ character_id: string }>(
      sql`SELECT character_id FROM user_characters WHERE user_id = ${userId}`
    );
    return rows.map((r) => r.character_id);
  }

  setAssignedCharacters(userId: string, characterIds: string[]): void {
    this.db.run(sql`DELETE FROM user_characters WHERE user_id = ${userId}`);
    for (const cid of characterIds) {
      this.db.run(sql`INSERT OR IGNORE INTO user_characters (user_id, character_id) VALUES (${userId}, ${cid})`);
    }
  }

  getAssignedStoryIds(userId: string): string[] {
    const rows = this.db.all<{ story_id: string }>(
      sql`SELECT story_id FROM user_stories WHERE user_id = ${userId}`
    );
    return rows.map((r) => r.story_id);
  }

  setAssignedStories(userId: string, storyIds: string[]): void {
    this.db.run(sql`DELETE FROM user_stories WHERE user_id = ${userId}`);
    for (const sid of storyIds) {
      this.db.run(sql`INSERT OR IGNORE INTO user_stories (user_id, story_id) VALUES (${userId}, ${sid})`);
    }
  }
}
