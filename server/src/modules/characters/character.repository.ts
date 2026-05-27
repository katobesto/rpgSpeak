import { eq, like, sql, and } from 'drizzle-orm';
import { getDb } from '../../db/index.js';
import { characters, storyCharacters, type DbCharacter } from '../../db/schema.js';
import type { Character } from '@rpgspeak/shared';
import { v4 as uuidv4 } from 'uuid';

/** Resolve user display_name from users table — single fast lookup */
function resolveOwnerName(userId: string | null | undefined): string | null {
  if (!userId) return null;
  const db = getDb();
  const row = db.get<{ display_name: string }>(
    sql`SELECT display_name FROM users WHERE id = ${userId} LIMIT 1`
  );
  return row?.display_name ?? null;
}

function now(): string {
  return new Date().toISOString();
}

function dbToCharacter(row: DbCharacter, storyIds: string[] = []): Character {
  const userId = (row as unknown as { userId?: string | null }).userId ?? null;
  return {
    id: row.id,
    userId,
    ownerName: resolveOwnerName(userId),
    storyIds,
    name: row.name,
    avatar: row.avatar,
    description: row.description,
    personality: row.personality,
    systemPrompt: row.systemPrompt,
    lore: row.lore,
    exampleDialogue: JSON.parse(row.exampleDialogue),
    tags: JSON.parse(row.tags),
    temperature: row.temperature,
    modelId: row.modelId,
    providerId: row.providerId,
    contextLength: row.contextLength,
    memoryEnabled: Boolean(row.memoryEnabled),
    memoryType: row.memoryType as Character['memoryType'],
    memoryWindow: row.memoryWindow,
    llmParams: JSON.parse(row.llmParams),
    relations: JSON.parse(row.relations),
    rpgStats: JSON.parse((row as unknown as Record<string, string>).rpgStats ?? '{}'),
    imageDescription: row.imageDescription ?? null,
    gallery: JSON.parse(row.gallery ?? '[]'),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class CharacterRepository {
  private get db() {
    return getDb();
  }

  private getStoryIds(characterId: string): string[] {
    return this.db
      .select({ storyId: storyCharacters.storyId })
      .from(storyCharacters)
      .where(eq(storyCharacters.characterId, characterId))
      .all()
      .map((r) => r.storyId);
  }

  findAll(search?: string, userId?: string, isAdmin = false, storyId?: string): Character[] {
    const conds = [];
    if (search) conds.push(like(characters.name, `%${search}%`));
    if (!isAdmin && userId) {
      // own characters OR characters explicitly assigned by admin
      conds.push(sql`(${characters.userId} = ${userId} OR ${characters.id} IN (
        SELECT character_id FROM user_characters WHERE user_id = ${userId}
      ))`);
    }
    if (storyId) {
      conds.push(sql`${characters.id} IN (
        SELECT character_id FROM story_characters WHERE story_id = ${storyId}
      )`);
    }
    let query = this.db.select().from(characters).$dynamic();
    if (conds.length === 1) query = query.where(conds[0]);
    else if (conds.length > 1) query = query.where(and(...conds));
    return query.all().map((row) => dbToCharacter(row, this.getStoryIds(row.id)));
  }

  findById(id: string): Character | null {
    const row = this.db.select().from(characters).where(eq(characters.id, id)).get();
    return row ? dbToCharacter(row, this.getStoryIds(id)) : null;
  }

  create(data: Omit<Character, 'id' | 'createdAt' | 'updatedAt' | 'userId' | 'ownerName' | 'storyIds'>, userId?: string): Character {
    const id = uuidv4();
    const ts = now();
    this.db.run(sql`
      INSERT INTO characters (
        id, name, avatar, description, personality, system_prompt, lore,
        example_dialogue, tags, temperature, model_id, provider_id,
        context_length, memory_enabled, memory_type, memory_window,
        llm_params, relations, rpg_stats, image_description, gallery,
        user_id, created_at, updated_at
      ) VALUES (
        ${id}, ${data.name}, ${data.avatar ?? null}, ${data.description},
        ${data.personality}, ${data.systemPrompt}, ${data.lore},
        ${JSON.stringify(data.exampleDialogue)}, ${JSON.stringify(data.tags)},
        ${data.temperature}, ${data.modelId ?? null}, ${data.providerId ?? null},
        ${data.contextLength}, ${data.memoryEnabled ? 1 : 0}, ${data.memoryType},
        ${data.memoryWindow}, ${JSON.stringify(data.llmParams)},
        ${JSON.stringify(data.relations)}, ${JSON.stringify(data.rpgStats ?? {})},
        ${data.imageDescription ?? null}, ${JSON.stringify(data.gallery ?? [])},
        ${userId ?? null}, ${ts}, ${ts}
      )
    `);
    return this.findById(id)!;
  }

  update(id: string, data: Partial<Omit<Character, 'id' | 'createdAt' | 'updatedAt' | 'storyIds'>>): Character | null {
    const existing = this.findById(id);
    if (!existing) return null;
    const ts = now();
    const merged = { ...existing, ...data };
    this.db.run(sql`
      UPDATE characters SET
        name            = ${merged.name},
        avatar          = ${merged.avatar ?? null},
        description     = ${merged.description},
        personality     = ${merged.personality},
        system_prompt   = ${merged.systemPrompt},
        lore            = ${merged.lore},
        example_dialogue= ${JSON.stringify(merged.exampleDialogue)},
        tags            = ${JSON.stringify(merged.tags)},
        temperature     = ${merged.temperature},
        model_id        = ${merged.modelId ?? null},
        provider_id     = ${merged.providerId ?? null},
        context_length  = ${merged.contextLength},
        memory_enabled  = ${merged.memoryEnabled ? 1 : 0},
        memory_type     = ${merged.memoryType},
        memory_window   = ${merged.memoryWindow},
        llm_params      = ${JSON.stringify(merged.llmParams)},
        relations       = ${JSON.stringify(merged.relations)},
        rpg_stats       = ${JSON.stringify(data.rpgStats ?? merged.rpgStats ?? {})},
        image_description = ${merged.imageDescription ?? null},
        gallery         = ${JSON.stringify(merged.gallery ?? [])},
        updated_at      = ${ts}
      WHERE id = ${id}
    `);
    return this.findById(id)!;
  }

  delete(id: string): boolean {
    this.db.run(sql`DELETE FROM characters WHERE id = ${id}`);
    return true;
  }

  duplicate(id: string): Character | null {
    const original = this.findById(id);
    if (!original) return null;
    const { id: _id, createdAt: _ca, updatedAt: _ua, ...data } = original;
    return this.create({ ...data, name: `${original.name} (copy)` });
  }

  count(): number {
    const result = this.db.select({ count: sql<number>`count(*)` }).from(characters).get();
    return result?.count ?? 0;
  }
}
