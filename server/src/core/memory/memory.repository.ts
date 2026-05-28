import { eq, and, desc } from 'drizzle-orm';
import { getDb } from '../../db/index.js';
import { memoryEntries, type DbMemoryEntry } from '../../db/schema.js';
import type { MemoryEntry } from '@rpgspeak/shared';
import { v4 as uuidv4 } from 'uuid';

function now() { return new Date().toISOString(); }

function dbToEntry(row: DbMemoryEntry): MemoryEntry {
  return {
    id: row.id,
    conversationId: row.conversationId,
    characterId: row.characterId,
    type: row.type as MemoryEntry['type'],
    content: row.content,
    importance: row.importance,
    isActive: row.isActive,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class MemoryRepository {
  private get db() { return getDb(); }

  findByConversation(conversationId: string, characterId?: string): MemoryEntry[] {
    const rows = characterId
      ? this.db.select().from(memoryEntries)
          .where(and(
            eq(memoryEntries.conversationId, conversationId),
            eq(memoryEntries.characterId, characterId),
            eq(memoryEntries.isActive, true)
          ))
          .orderBy(desc(memoryEntries.importance), desc(memoryEntries.createdAt))
          .all()
      : this.db.select().from(memoryEntries)
          .where(and(
            eq(memoryEntries.conversationId, conversationId),
            eq(memoryEntries.isActive, true)
          ))
          .orderBy(desc(memoryEntries.importance), desc(memoryEntries.createdAt))
          .all();
    return rows.map(dbToEntry);
  }

  create(data: Omit<MemoryEntry, 'id' | 'createdAt' | 'updatedAt'>): MemoryEntry {
    const id = uuidv4();
    const ts = now();
    this.db.insert(memoryEntries).values({
      id,
      conversationId: data.conversationId,
      characterId: data.characterId ?? null,
      type: data.type,
      content: data.content,
      importance: data.importance,
      isActive: data.isActive,
      createdAt: ts,
      updatedAt: ts,
    }).run();
    return this.findById(id)!;
  }

  findById(id: string): MemoryEntry | null {
    const row = this.db.select().from(memoryEntries).where(eq(memoryEntries.id, id)).get();
    return row ? dbToEntry(row) : null;
  }

  deactivate(id: string): void {
    this.db.update(memoryEntries).set({ isActive: false, updatedAt: now() })
      .where(eq(memoryEntries.id, id)).run();
  }
}
