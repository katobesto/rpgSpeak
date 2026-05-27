import { eq, and, sql } from 'drizzle-orm';
import { getDb } from '../../db/index.js';
import { messages, type DbMessage } from '../../db/schema.js';
import type { Message } from '@rpgspeak/shared';
import { v4 as uuidv4 } from 'uuid';

function now() {
  return new Date().toISOString();
}

function dbToMessage(row: DbMessage): Message {
  return {
    id: row.id,
    conversationId: row.conversationId,
    parentId: row.parentId,
    branchId: row.branchId,
    role: row.role as Message['role'],
    content: row.content,
    characterId: row.characterId,
    tokens: row.tokens,
    isActive: Boolean(row.isActive),
    metadata: JSON.parse(row.metadata),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class MessageRepository {
  private get db() {
    return getDb();
  }

  findByConversation(conversationId: string, branchId = 'main'): Message[] {
    const rows = this.db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, conversationId),
          eq(messages.branchId, branchId),
          eq(messages.isActive, true)
        )
      )
      .all();
    return rows.map(dbToMessage);
  }

  findById(id: string): Message | null {
    const row = this.db.select().from(messages).where(eq(messages.id, id)).get();
    return row ? dbToMessage(row) : null;
  }

  create(data: {
    conversationId: string;
    role: Message['role'];
    content: string;
    characterId?: string;
    parentId?: string;
    branchId?: string;
    tokens?: number;
    metadata?: Record<string, unknown>;
  }): Message {
    const id = uuidv4();
    const ts = now();
    this.db.run(sql`
      INSERT INTO messages (
        id, conversation_id, parent_id, branch_id, role, content,
        character_id, tokens, is_active, metadata, created_at, updated_at
      ) VALUES (
        ${id}, ${data.conversationId}, ${data.parentId ?? null},
        ${data.branchId ?? 'main'}, ${data.role}, ${data.content},
        ${data.characterId ?? null}, ${data.tokens ?? 0}, 1,
        ${JSON.stringify(data.metadata ?? {})}, ${ts}, ${ts}
      )
    `);
    return this.findById(id)!;
  }

  update(id: string, data: { content?: string; tokens?: number; metadata?: Record<string, unknown> }): Message | null {
    const ts = now();
    if (data.content !== undefined) this.db.run(sql`UPDATE messages SET content = ${data.content}, updated_at = ${ts} WHERE id = ${id}`);
    if (data.tokens !== undefined) this.db.run(sql`UPDATE messages SET tokens = ${data.tokens}, updated_at = ${ts} WHERE id = ${id}`);
    if (data.metadata !== undefined) this.db.run(sql`UPDATE messages SET metadata = ${JSON.stringify(data.metadata)}, updated_at = ${ts} WHERE id = ${id}`);
    return this.findById(id);
  }

  deactivateBranch(conversationId: string, fromMessageId: string): void {
    const ts = now();
    this.db.run(sql`
      UPDATE messages SET is_active = 0, updated_at = ${ts}
      WHERE conversation_id = ${conversationId} AND parent_id = ${fromMessageId}
    `);
  }

  delete(id: string): boolean {
    this.db.run(sql`DELETE FROM messages WHERE id = ${id}`);
    return true;
  }
}
