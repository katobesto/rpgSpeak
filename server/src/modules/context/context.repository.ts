import { eq, and, desc, isNull } from 'drizzle-orm';
import { getDb } from '../../db/index.js';
import { contextItems, type DbContextItem } from '../../db/schema.js';
import type { ContextItem } from '@rpgspeak/shared';
import { v4 as uuidv4 } from 'uuid';

function now() { return new Date().toISOString(); }

function dbToItem(row: DbContextItem): ContextItem {
  return {
    id:               row.id,
    conversationId:   row.conversationId,
    type:             row.type as ContextItem['type'],
    title:            row.title,
    description:      row.description,
    importance:       row.importance,
    messageIndexFrom: row.messageIndexFrom,
    messageIndexTo:   row.messageIndexTo,
    isActive:         row.isActive,
    createdAt:        row.createdAt,
    updatedAt:        row.updatedAt,
  };
}

// Extended internal row type that includes the new optional columns
type DbContextItemFull = DbContextItem & {
  embedding:      Buffer | null;
  embeddingModel: string | null;
};

// Public type returned by findByConversationWithEmbeddings
export type ContextItemWithEmbedding = ContextItem & {
  embeddingVec:   Float32Array | null;
  embeddingModel: string | null;
};

type CreateDto = {
  conversationId:   string;
  type:             'event' | 'character' | 'place' | 'quest';
  title:            string;
  description:      string;
  importance:       number;
  messageIndexFrom: number;
  messageIndexTo:   number;
};

export class ContextRepository {
  private get db() { return getDb(); }

  findByConversation(conversationId: string): ContextItem[] {
    return this.db
      .select()
      .from(contextItems)
      .where(and(eq(contextItems.conversationId, conversationId), eq(contextItems.isActive, true)))
      .orderBy(desc(contextItems.importance), desc(contextItems.createdAt))
      .all()
      .map(dbToItem);
  }

  /** Returns all active items with their embedding vectors deserialized (for semantic scoring). */
  findByConversationWithEmbeddings(conversationId: string): ContextItemWithEmbedding[] {
    const rows = this.db
      .select()
      .from(contextItems)
      .where(and(eq(contextItems.conversationId, conversationId), eq(contextItems.isActive, true)))
      .orderBy(desc(contextItems.importance), desc(contextItems.createdAt))
      .all() as DbContextItemFull[];

    return rows.map((row) => ({
      ...dbToItem(row),
      embeddingVec: row.embedding
        ? new Float32Array(
            row.embedding.buffer,
            row.embedding.byteOffset,
            row.embedding.byteLength / 4,
          )
        : null,
      embeddingModel: row.embeddingModel ?? null,
    }));
  }

  /** Returns active items that have no stored embedding yet (for batch embedding). */
  findWithoutEmbedding(conversationId: string): ContextItem[] {
    const rows = this.db
      .select()
      .from(contextItems)
      .where(
        and(
          eq(contextItems.conversationId, conversationId),
          eq(contextItems.isActive, true),
          isNull((contextItems as any).embedding),
        ),
      )
      .all();
    return rows.map(dbToItem);
  }

  create(data: CreateDto): ContextItem {
    const id = uuidv4();
    const ts = now();
    this.db.insert(contextItems).values({ id, ...data, isActive: true, createdAt: ts, updatedAt: ts }).run();
    return dbToItem(this.db.select().from(contextItems).where(eq(contextItems.id, id)).get()!);
  }

  /** Stores a Float32 embedding vector for an item. */
  updateEmbedding(id: string, vec: Float32Array, model: string): void {
    const buf = Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
    this.db
      .update(contextItems)
      .set({ embedding: buf as any, embeddingModel: model, updatedAt: now() } as any)
      .where(eq(contextItems.id, id))
      .run();
  }

  update(id: string, data: Partial<Pick<ContextItem, 'title' | 'description' | 'importance'>>): ContextItem | null {
    this.db.update(contextItems).set({ ...data, updatedAt: now() }).where(eq(contextItems.id, id)).run();
    const row = this.db.select().from(contextItems).where(eq(contextItems.id, id)).get();
    return row ? dbToItem(row) : null;
  }

  delete(id: string): void {
    this.db.delete(contextItems).where(eq(contextItems.id, id)).run();
  }

  deleteByConversation(conversationId: string): void {
    this.db.delete(contextItems).where(eq(contextItems.conversationId, conversationId)).run();
  }
}
