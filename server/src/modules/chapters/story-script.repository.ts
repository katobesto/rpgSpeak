import { eq, asc } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../../db/index.js';
import { storyScriptChapters, type DbStoryScriptChapter } from '../../db/schema.js';
import type { StoryScriptChapter } from '@rpgspeak/shared';

function dbToScript(row: DbStoryScriptChapter): StoryScriptChapter {
  return {
    id:            row.id,
    storyId:       row.storyId,
    chapterNumber: row.chapterNumber,
    title:         row.title,
    description:   row.description,
    createdAt:     row.createdAt,
  };
}

function now() { return new Date().toISOString(); }

export class StoryScriptRepository {
  private get db() { return getDb(); }

  findByStory(storyId: string): StoryScriptChapter[] {
    return this.db
      .select()
      .from(storyScriptChapters)
      .where(eq(storyScriptChapters.storyId, storyId))
      .orderBy(asc(storyScriptChapters.chapterNumber))
      .all()
      .map(dbToScript);
  }

  hasScript(storyId: string): boolean {
    const row = this.db
      .select({ id: storyScriptChapters.id })
      .from(storyScriptChapters)
      .where(eq(storyScriptChapters.storyId, storyId))
      .get();
    return !!row;
  }

  createBatch(storyId: string, chapters: { number: number; title: string; description: string }[]): void {
    // Reemplaza el guión existente
    this.db.run(sql`DELETE FROM story_script_chapters WHERE story_id = ${storyId}`);
    const ts = now();
    for (const ch of chapters) {
      this.db.run(sql`
        INSERT INTO story_script_chapters (id, story_id, chapter_number, title, description, created_at)
        VALUES (${uuidv4()}, ${storyId}, ${ch.number}, ${ch.title}, ${ch.description}, ${ts})
      `);
    }
  }

  deleteByStory(storyId: string): void {
    this.db.run(sql`DELETE FROM story_script_chapters WHERE story_id = ${storyId}`);
  }
}
