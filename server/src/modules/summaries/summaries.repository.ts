import { eq, desc } from 'drizzle-orm';
import { getDb } from '../../db/index.js';
import { conversationSummaries, type DbConversationSummary } from '../../db/schema.js';
import type { ConversationSummary } from '@rpgspeak/shared';
import { v4 as uuidv4 } from 'uuid';

function now() { return new Date().toISOString(); }

function dbToSummary(row: DbConversationSummary): ConversationSummary {
  return {
    id: row.id,
    conversationId: row.conversationId,
    content: row.content,
    messageIndexFrom: row.messageIndexFrom,
    messageIndexTo: row.messageIndexTo,
    createdAt: row.createdAt,
  };
}

export class SummariesRepository {
  private get db() { return getDb(); }

  findByConversation(conversationId: string): ConversationSummary[] {
    const rows = this.db.select().from(conversationSummaries)
      .where(eq(conversationSummaries.conversationId, conversationId))
      .orderBy(desc(conversationSummaries.createdAt))
      .all();
    return rows.map(dbToSummary);
  }

  create(data: {
    conversationId: string;
    content: string;
    messageIndexFrom: number;
    messageIndexTo: number;
  }): ConversationSummary {
    const id = uuidv4();
    const ts = now();
    this.db.insert(conversationSummaries).values({
      id,
      conversationId: data.conversationId,
      content: data.content,
      messageIndexFrom: data.messageIndexFrom,
      messageIndexTo: data.messageIndexTo,
      createdAt: ts,
    }).run();
    const row = this.db.select().from(conversationSummaries)
      .where(eq(conversationSummaries.id, id)).get()!;
    return dbToSummary(row);
  }

  delete(id: string): void {
    this.db.delete(conversationSummaries).where(eq(conversationSummaries.id, id)).run();
  }
}
