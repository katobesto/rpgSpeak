import { eq, desc, sql } from 'drizzle-orm';
import { getDb } from '../../db/index.js';
import {
  conversations,
  conversationCharacters,
  conversationStories,
  type DbConversation,
} from '../../db/schema.js';
import type { Conversation, ConversationCharacterLink, ConversationStoryLink } from '@rpgspeak/shared';
import { v4 as uuidv4 } from 'uuid';

function now() {
  return new Date().toISOString();
}

function dbToConversation(
  row: DbConversation,
  chars: ConversationCharacterLink[],
  storiesLinks: ConversationStoryLink[]
): Conversation {
  return {
    id: row.id,
    title: row.title,
    summary: row.summary,
    mode: row.mode as Conversation['mode'],
    activeCharacterId: row.activeCharacterId,
    isArchived: Boolean(row.isArchived),
    tokenCount: row.tokenCount,
    messageCount: row.messageCount,
    characters: chars,
    stories: storiesLinks,
    metadata: JSON.parse(row.metadata),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class ConversationRepository {
  private get db() {
    return getDb();
  }

  private getChars(conversationId: string): ConversationCharacterLink[] {
    return this.db
      .select()
      .from(conversationCharacters)
      .where(eq(conversationCharacters.conversationId, conversationId))
      .all()
      .map((r) => ({ characterId: r.characterId, order: r.order, affinity: (r as any).affinity ?? 50 }));
  }

  private getStories(conversationId: string): ConversationStoryLink[] {
    return this.db
      .select()
      .from(conversationStories)
      .where(eq(conversationStories.conversationId, conversationId))
      .all()
      .map((r) => ({ storyId: r.storyId, priority: r.priority }));
  }

  findAll(includeArchived = false, userId?: string, isAdmin = false): Conversation[] {
    let query = this.db.select().from(conversations).$dynamic();

    if (!includeArchived) {
      query = query.where(eq(conversations.isArchived, false));
    }
    // Admin sees everything; regular users see only their own
    if (!isAdmin && userId) {
      query = query.where(eq(conversations.userId, userId));
    }

    const rows = query.orderBy(desc(conversations.updatedAt)).all();
    return rows.map((r) => dbToConversation(r, this.getChars(r.id), this.getStories(r.id)));
  }

  findById(id: string): Conversation | null {
    const row = this.db.select().from(conversations).where(eq(conversations.id, id)).get();
    return row ? dbToConversation(row, this.getChars(id), this.getStories(id)) : null;
  }

  create(data: {
    title?: string;
    mode?: Conversation['mode'];
    characterIds?: string[];
    storyIds?: string[];
    userId?: string;
  }): Conversation {
    const id = uuidv4();
    const ts = now();
    const title = data.title || 'New Conversation';

    this.db.run(sql`
      INSERT INTO conversations (
        id, title, mode, is_archived, token_count, message_count, metadata, user_id, created_at, updated_at
      ) VALUES (
        ${id}, ${title}, ${data.mode ?? 'single'}, 0, 0, 0, '{}', ${data.userId ?? null}, ${ts}, ${ts}
      )
    `);

    for (const [i, cid] of (data.characterIds ?? []).entries()) {
      this.db.run(sql`
        INSERT INTO conversation_characters (conversation_id, character_id, "order")
        VALUES (${id}, ${cid}, ${i})
      `);
    }

    for (const [i, sid] of (data.storyIds ?? []).entries()) {
      this.db.run(sql`
        INSERT INTO conversation_stories (conversation_id, story_id, priority)
        VALUES (${id}, ${sid}, ${i})
      `);
    }

    return this.findById(id)!;
  }

  update(id: string, data: {
    title?: string;
    activeCharacterId?: string | null;
    isArchived?: boolean;
    summary?: string | null;
    tokenCount?: number;
    messageCount?: number;
    characterIds?: string[];
    storyIds?: string[];
  }): Conversation | null {
    if (!this.findById(id)) return null;
    const ts = now();

    if (data.title !== undefined) this.db.run(sql`UPDATE conversations SET title = ${data.title}, updated_at = ${ts} WHERE id = ${id}`);
    if (data.activeCharacterId !== undefined) this.db.run(sql`UPDATE conversations SET active_character_id = ${data.activeCharacterId}, updated_at = ${ts} WHERE id = ${id}`);
    if (data.isArchived !== undefined) this.db.run(sql`UPDATE conversations SET is_archived = ${data.isArchived ? 1 : 0}, updated_at = ${ts} WHERE id = ${id}`);
    if (data.summary !== undefined) this.db.run(sql`UPDATE conversations SET summary = ${data.summary}, updated_at = ${ts} WHERE id = ${id}`);
    if (data.tokenCount !== undefined) this.db.run(sql`UPDATE conversations SET token_count = ${data.tokenCount}, updated_at = ${ts} WHERE id = ${id}`);
    if (data.messageCount !== undefined) this.db.run(sql`UPDATE conversations SET message_count = ${data.messageCount}, updated_at = ${ts} WHERE id = ${id}`);

    if (data.characterIds !== undefined) {
      this.db.run(sql`DELETE FROM conversation_characters WHERE conversation_id = ${id}`);
      for (const [i, cid] of data.characterIds.entries()) {
        this.db.run(sql`
          INSERT INTO conversation_characters (conversation_id, character_id, "order")
          VALUES (${id}, ${cid}, ${i})
        `);
      }
    }

    if (data.storyIds !== undefined) {
      this.db.run(sql`DELETE FROM conversation_stories WHERE conversation_id = ${id}`);
      for (const [i, sid] of data.storyIds.entries()) {
        this.db.run(sql`
          INSERT INTO conversation_stories (conversation_id, story_id, priority)
          VALUES (${id}, ${sid}, ${i})
        `);
      }
    }

    return this.findById(id)!;
  }

  delete(id: string): boolean {
    this.db.run(sql`DELETE FROM conversations WHERE id = ${id}`);
    return true;
  }

  updateCharacterAffinity(conversationId: string, characterId: string, newAffinity: number): void {
    const clamped = Math.max(1, Math.min(100, newAffinity));
    this.db.run(sql`
      UPDATE conversation_characters
      SET affinity = ${clamped}
      WHERE conversation_id = ${conversationId} AND character_id = ${characterId}
    `);
  }

  incrementCounts(id: string, tokens: number): void {
    const ts = now();
    this.db.run(sql`
      UPDATE conversations
      SET token_count   = token_count + ${tokens},
          message_count = message_count + 1,
          updated_at    = ${ts}
      WHERE id = ${id}
    `);
  }
}
