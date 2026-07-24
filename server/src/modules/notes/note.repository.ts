import { eq, asc, max } from 'drizzle-orm';
import { getDb } from '../../db/index.js';
import { conversationNotes, type DbConversationNote } from '../../db/schema.js';
import type { ConversationNote } from '@rpgspeak/shared';
import { v4 as uuidv4 } from 'uuid';

function now() { return new Date().toISOString(); }

function dbToNote(row: DbConversationNote): ConversationNote {
  return {
    id:             row.id,
    conversationId: row.conversationId,
    content:        row.content,
    position:       row.position,
    createdAt:      row.createdAt,
    updatedAt:      row.updatedAt,
  };
}

export class NoteRepository {
  private get db() { return getDb(); }

  /** Notas en orden de inyección/visualización (el que el usuario definió). */
  findByConversation(conversationId: string): ConversationNote[] {
    return this.db
      .select()
      .from(conversationNotes)
      .where(eq(conversationNotes.conversationId, conversationId))
      .orderBy(asc(conversationNotes.position))
      .all()
      .map(dbToNote);
  }

  findById(id: string): ConversationNote | null {
    const row = this.db.select().from(conversationNotes).where(eq(conversationNotes.id, id)).get();
    return row ? dbToNote(row) : null;
  }

  /** Se añade siempre al final de la lista. */
  create(conversationId: string, content: string): ConversationNote {
    const maxPos = this.db
      .select({ maxPos: max(conversationNotes.position) })
      .from(conversationNotes)
      .where(eq(conversationNotes.conversationId, conversationId))
      .get();
    const position = (maxPos?.maxPos ?? -1) + 1;

    const id = uuidv4();
    const ts = now();
    this.db.insert(conversationNotes).values({
      id, conversationId, content, position, createdAt: ts, updatedAt: ts,
    }).run();
    return this.findById(id)!;
  }

  update(id: string, content: string): ConversationNote | null {
    if (!this.findById(id)) return null;
    this.db.update(conversationNotes).set({ content, updatedAt: now() }).where(eq(conversationNotes.id, id)).run();
    return this.findById(id);
  }

  delete(id: string): boolean {
    const res = this.db.delete(conversationNotes).where(eq(conversationNotes.id, id)).run();
    return res.changes > 0;
  }

  /**
   * Reordena TODAS las notas de la conversación según la lista de ids dada
   * (el orden completo, tal como lo deja el usuario tras arrastrar). Ids que no
   * pertenezcan a la conversación se ignoran — defensivo ante una llamada con
   * datos obsoletos del cliente.
   */
  reorder(conversationId: string, orderedIds: string[]): ConversationNote[] {
    const existing = new Set(this.findByConversation(conversationId).map((n) => n.id));
    const ts = now();
    let position = 0;
    for (const id of orderedIds) {
      if (!existing.has(id)) continue;
      this.db.update(conversationNotes).set({ position, updatedAt: ts }).where(eq(conversationNotes.id, id)).run();
      position++;
    }
    return this.findByConversation(conversationId);
  }
}
