import { eq, and, asc } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../../db/index.js';
import { storyChapters, type DbStoryChapter } from '../../db/schema.js';
import type { StoryChapter } from '@rpgspeak/shared';

function dbToChapter(row: DbStoryChapter): StoryChapter {
  return {
    id:             row.id,
    conversationId: row.conversationId,
    chapterNumber:  row.chapterNumber,
    title:          row.title,
    description:    row.description,
    isCompleted:    Boolean(row.isCompleted),
    completedAt:    row.completedAt ?? null,
    createdAt:      row.createdAt,
  };
}

function now() { return new Date().toISOString(); }

export class ChapterRepository {
  private get db() { return getDb(); }

  findByConversation(conversationId: string): StoryChapter[] {
    const rows = this.db
      .select()
      .from(storyChapters)
      .where(eq(storyChapters.conversationId, conversationId))
      .orderBy(asc(storyChapters.chapterNumber))
      .all();
    return rows.map(dbToChapter);
  }

  /** El primer capítulo no completado (el activo) */
  findCurrentChapter(conversationId: string): StoryChapter | null {
    const row = this.db
      .select()
      .from(storyChapters)
      .where(and(
        eq(storyChapters.conversationId, conversationId),
        eq(storyChapters.isCompleted, false),
      ))
      .orderBy(asc(storyChapters.chapterNumber))
      .get();
    return row ? dbToChapter(row) : null;
  }

  hasChapters(conversationId: string): boolean {
    const row = this.db
      .select({ id: storyChapters.id })
      .from(storyChapters)
      .where(eq(storyChapters.conversationId, conversationId))
      .get();
    return !!row;
  }

  createBatch(conversationId: string, chapters: { number: number; title: string; description: string }[]): void {
    const ts = now();
    for (const ch of chapters) {
      this.db.run(sql`
        INSERT INTO story_chapters (id, conversation_id, chapter_number, title, description, is_completed, created_at)
        VALUES (${uuidv4()}, ${conversationId}, ${ch.number}, ${ch.title}, ${ch.description}, 0, ${ts})
      `);
    }
  }

  /** Copia el guión maestro de una historia a esta conversación */
  copyFromScript(conversationId: string, scriptChapters: import('@rpgspeak/shared').StoryScriptChapter[]): void {
    if (scriptChapters.length === 0) return;
    this.createBatch(conversationId, scriptChapters.map(c => ({
      number:      c.chapterNumber,
      title:       c.title,
      description: c.description,
    })));
  }

  /** Marca el capítulo activo como completado. Devuelve el siguiente capítulo (si existe). */
  completeCurrentChapter(conversationId: string): { completed: StoryChapter; next: StoryChapter | null } | null {
    const current = this.findCurrentChapter(conversationId);
    if (!current) return null;

    const ts = now();
    this.db.run(sql`
      UPDATE story_chapters
      SET is_completed = 1, completed_at = ${ts}
      WHERE id = ${current.id}
    `);

    const next = this.findCurrentChapter(conversationId);
    return { completed: { ...current, isCompleted: true, completedAt: ts }, next };
  }

  /** Marca un capítulo concreto como completado o pendiente */
  setCompleted(id: string, completed: boolean): StoryChapter | null {
    const ts = now();
    if (completed) {
      this.db.run(sql`UPDATE story_chapters SET is_completed = 1, completed_at = ${ts} WHERE id = ${id}`);
    } else {
      this.db.run(sql`UPDATE story_chapters SET is_completed = 0, completed_at = NULL WHERE id = ${id}`);
    }
    const row = this.db.select().from(storyChapters).where(eq(storyChapters.id, id)).get();
    return row ? dbToChapter(row) : null;
  }

  /**
   * Hace que un capítulo sea el "activo":
   * - Completa todos los capítulos con número MENOR
   * - Deja pendiente este capítulo y todos los POSTERIORES
   */
  setActive(id: string): void {
    const row = this.db.select().from(storyChapters).where(eq(storyChapters.id, id)).get();
    if (!row) return;
    const ts = now();
    // Completar anteriores
    this.db.run(sql`
      UPDATE story_chapters
      SET is_completed = 1, completed_at = ${ts}
      WHERE conversation_id = ${row.conversationId}
        AND chapter_number < ${row.chapterNumber}
        AND is_completed = 0
    `);
    // Dejar pendiente este y los posteriores
    this.db.run(sql`
      UPDATE story_chapters
      SET is_completed = 0, completed_at = NULL
      WHERE conversation_id = ${row.conversationId}
        AND chapter_number >= ${row.chapterNumber}
    `);
  }

  deleteByConversation(conversationId: string): void {
    this.db.run(sql`DELETE FROM story_chapters WHERE conversation_id = ${conversationId}`);
  }
}
