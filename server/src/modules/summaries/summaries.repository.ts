import { eq, and, gt, asc, desc, inArray, sql } from 'drizzle-orm';
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
    kind: row.kind === 'block' ? 'block' : row.kind === 'arc' ? 'arc' : 'manual',
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

  /** Bloques automáticos inmutables, en orden cronológico de la historia. */
  findBlocks(conversationId: string): ConversationSummary[] {
    const rows = this.db.select().from(conversationSummaries)
      .where(and(
        eq(conversationSummaries.conversationId, conversationId),
        eq(conversationSummaries.kind, 'block'),
      ))
      .orderBy(asc(conversationSummaries.messageIndexFrom))
      .all();
    return rows.map(dbToSummary);
  }

  /** Resúmenes de arco (pasado lejano, un arco ≈ 4 bloques), orden cronológico. */
  findArcs(conversationId: string): ConversationSummary[] {
    const rows = this.db.select().from(conversationSummaries)
      .where(and(
        eq(conversationSummaries.conversationId, conversationId),
        eq(conversationSummaries.kind, 'arc'),
      ))
      .orderBy(asc(conversationSummaries.messageIndexFrom))
      .all();
    return rows.map(dbToSummary);
  }

  create(data: {
    conversationId: string;
    content: string;
    messageIndexFrom: number;
    messageIndexTo: number;
    kind?: 'block' | 'manual' | 'arc';
  }): ConversationSummary {
    const id = uuidv4();
    const ts = now();
    this.db.insert(conversationSummaries).values({
      id,
      conversationId: data.conversationId,
      content: data.content,
      messageIndexFrom: data.messageIndexFrom,
      messageIndexTo: data.messageIndexTo,
      kind: data.kind ?? 'manual',
      createdAt: ts,
    }).run();
    const row = this.db.select().from(conversationSummaries)
      .where(eq(conversationSummaries.id, id)).get()!;
    return dbToSummary(row);
  }

  delete(id: string): void {
    this.db.delete(conversationSummaries).where(eq(conversationSummaries.id, id)).run();
  }

  /** Elimina bloques duplicados (mismo messageIndexFrom), conservando el más
   *  antiguo. Los duplicados existen por una carrera histórica: dos pasadas
   *  fire-and-forget concurrentes veían el mismo bloque sin cubrir y lo creaban
   *  ambas — y "Historia hasta ahora" inyectaba el contenido dos veces.
   *  Devuelve cuántas filas ha borrado. */
  dedupeBlocks(conversationId: string): number {
    const res = this.db.run(sql`
      DELETE FROM conversation_summaries
      WHERE conversation_id = ${conversationId}
        AND kind IN ('block', 'arc')
        AND id NOT IN (
          SELECT id FROM (
            SELECT id, MIN(created_at)
            FROM conversation_summaries
            WHERE conversation_id = ${conversationId} AND kind IN ('block', 'arc')
            GROUP BY kind, message_index_from
          )
        )
    `);
    return Number((res as { changes?: number }).changes ?? 0);
  }

  /** Borra los bloques Y ARCOS cuyo rango se extiende más allá de `anchorIndex` —
   *  se usa en el rebobinado por muerte: esos resúmenes narran una línea temporal
   *  borrada. Los totalmente anteriores al ancla siguen siendo válidos (inmutables).
   *  Los arcos entran también: un arco que condensa bloques borrados envenenaría
   *  el contexto con hechos que ya no ocurrieron. */
  deleteBlocksBeyond(conversationId: string, anchorIndex: number): void {
    this.db.delete(conversationSummaries)
      .where(and(
        eq(conversationSummaries.conversationId, conversationId),
        inArray(conversationSummaries.kind, ['block', 'arc']),
        gt(conversationSummaries.messageIndexTo, anchorIndex),
      ))
      .run();
  }
}
