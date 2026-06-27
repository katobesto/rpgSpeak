import { eq, sql } from 'drizzle-orm';
import { getDb } from '../../db/index.js';
import { conversationStoryEvents } from '../../db/schema.js';

/**
 * Estado por conversación de los eventos de historia (stories.persistent_events).
 * Una fila = el evento ya OCURRIÓ narrativamente en esa conversación.
 * Sin fila = el evento sigue pendiente (es un destino narrativo).
 */
export class EventStatusRepository {
  private get db() {
    return getDb();
  }

  /** IDs de eventos ya ocurridos en la conversación. */
  findOccurredIds(conversationId: string): Set<string> {
    const rows = this.db
      .select({ eventId: conversationStoryEvents.eventId })
      .from(conversationStoryEvents)
      .where(eq(conversationStoryEvents.conversationId, conversationId))
      .all();
    return new Set(rows.map((r) => r.eventId));
  }

  markOccurred(conversationId: string, storyId: string, eventId: string): void {
    this.db.run(sql`
      INSERT OR IGNORE INTO conversation_story_events (conversation_id, story_id, event_id, occurred_at)
      VALUES (${conversationId}, ${storyId}, ${eventId}, ${new Date().toISOString()})
    `);
  }

  /** Revierte un evento a pendiente (p.ej. si el usuario regenera la respuesta). */
  unmarkOccurred(conversationId: string, eventId: string): void {
    this.db.run(sql`
      DELETE FROM conversation_story_events
      WHERE conversation_id = ${conversationId} AND event_id = ${eventId}
    `);
  }
}
