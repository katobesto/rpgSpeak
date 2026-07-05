import { eq, like, sql, and } from 'drizzle-orm';
import { getDb } from '../../db/index.js';
import { stories, storyCharacters, type DbStory } from '../../db/schema.js';
import type { Story, StoryCharacterLink, StoryEvent, StoryLocation } from '@rpgspeak/shared';
import { v4 as uuidv4 } from 'uuid';

/** Normaliza eventos persistidos antes de añadir el campo trigger (evita undefined.trim()). */
function normalizeEvents(events: StoryEvent[]): StoryEvent[] {
  return events.map((e) => ({ ...e, trigger: e.trigger ?? '' }));
}

/** Normaliza ubicaciones persistidas con campos antiguos/incompletos. */
function normalizeLocations(locations: StoryLocation[]): StoryLocation[] {
  return locations.map((l) => ({
    ...l,
    description: l.description ?? '',
    contents: l.contents ?? '',
    exits: l.exits ?? '',
    atmosphere: l.atmosphere ?? '',
  }));
}

function resolveOwnerName(userId: string | null | undefined): string | null {
  if (!userId) return null;
  const db = getDb();
  const row = db.get<{ display_name: string }>(
    sql`SELECT display_name FROM users WHERE id = ${userId} LIMIT 1`
  );
  return row?.display_name ?? null;
}

function now() {
  return new Date().toISOString();
}

function dbToStory(row: DbStory, chars: StoryCharacterLink[] = []): Story {
  const userId = (row as unknown as { userId?: string | null }).userId ?? null;
  return {
    id: row.id,
    userId,
    ownerName: resolveOwnerName(userId),
    name: row.name,
    description: row.description,
    globalContext: row.globalContext,
    narrativeRules: row.narrativeRules,
    worldLore: row.worldLore,
    persistentEvents: normalizeEvents(JSON.parse(row.persistentEvents)),
    locations: normalizeLocations(JSON.parse((row as unknown as { locations?: string }).locations ?? '[]')),
    stateVariables: JSON.parse(row.stateVariables),
    behaviorRestrictions: JSON.parse(row.behaviorRestrictions),
    isActive: Boolean(row.isActive),
    adventureMode: Boolean(row.adventureMode),
    openWorld: Boolean(row.openWorld),
    deathMode: Boolean(row.deathMode),
    characters: chars,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class StoryRepository {
  private get db() {
    return getDb();
  }

  private getChars(storyId: string): StoryCharacterLink[] {
    return this.db
      .select()
      .from(storyCharacters)
      .where(eq(storyCharacters.storyId, storyId))
      .all()
      .map((r) => ({ characterId: r.characterId, role: r.role, notes: r.notes }));
  }

  findAll(params: {
    search?: string;       // búsqueda por título
    text?: string;         // búsqueda en contenido (descripción, contexto, lore, reglas)
    userId?: string;       // usuario actual (para filtrar visibilidad)
    isAdmin?: boolean;
    characterId?: string;  // filtrar por personaje vinculado
    filterUserId?: string; // solo admin: filtrar por propietario específico
  } = {}): Story[] {
    const { search, text, userId, isAdmin = false, characterId, filterUserId } = params;
    const conds = [];

    // Filtro por título
    if (search) conds.push(like(stories.name, `%${search}%`));

    // Búsqueda aproximada en campos de contenido
    if (text) {
      const pat = `%${text}%`;
      conds.push(sql`(
        ${stories.name}            LIKE ${pat} OR
        ${stories.description}     LIKE ${pat} OR
        ${stories.globalContext}   LIKE ${pat} OR
        ${stories.worldLore}       LIKE ${pat} OR
        ${stories.narrativeRules}  LIKE ${pat}
      )`);
    }

    // Visibilidad: admin ve todo; usuario normal solo ve lo suyo
    if (!isAdmin && userId) {
      conds.push(sql`(${stories.userId} = ${userId} OR ${stories.id} IN (
        SELECT story_id FROM user_stories WHERE user_id = ${userId}
      ))`);
    }

    // Filtro de propietario (solo admin)
    if (isAdmin && filterUserId) {
      conds.push(sql`${stories.userId} = ${filterUserId}`);
    }

    // Filtro por personaje vinculado
    if (characterId) {
      conds.push(sql`${stories.id} IN (
        SELECT story_id FROM story_characters WHERE character_id = ${characterId}
      )`);
    }

    let query = this.db.select().from(stories).$dynamic();
    if (conds.length === 1) query = query.where(conds[0]);
    else if (conds.length > 1) query = query.where(and(...conds));
    const rows = query.all();
    return rows.map((r) => dbToStory(r, this.getChars(r.id)));
  }

  findById(id: string): Story | null {
    const row = this.db.select().from(stories).where(eq(stories.id, id)).get();
    return row ? dbToStory(row, this.getChars(id)) : null;
  }

  create(data: Omit<Story, 'id' | 'createdAt' | 'updatedAt' | 'userId' | 'ownerName'>, userId?: string): Story {
    const id = uuidv4();
    const ts = now();
    this.db.run(sql`
      INSERT INTO stories (
        id, name, description, global_context, narrative_rules, world_lore,
        persistent_events, locations, state_variables, behavior_restrictions,
        is_active, adventure_mode, open_world, death_mode, user_id, created_at, updated_at
      ) VALUES (
        ${id}, ${data.name}, ${data.description}, ${data.globalContext},
        ${data.narrativeRules}, ${data.worldLore},
        ${JSON.stringify(data.persistentEvents)}, ${JSON.stringify(data.locations ?? [])},
        ${JSON.stringify(data.stateVariables)},
        ${JSON.stringify(data.behaviorRestrictions)},
        ${data.isActive ? 1 : 0}, ${data.adventureMode ? 1 : 0}, ${data.openWorld ? 1 : 0},
        ${data.deathMode ? 1 : 0}, ${userId ?? null}, ${ts}, ${ts}
      )
    `);

    for (const c of data.characters) {
      this.db.run(sql`
        INSERT INTO story_characters (story_id, character_id, role, notes)
        VALUES (${id}, ${c.characterId}, ${c.role}, ${c.notes})
      `);
    }

    return this.findById(id)!;
  }

  update(id: string, data: Partial<Omit<Story, 'id' | 'createdAt' | 'updatedAt'>>): Story | null {
    const existing = this.findById(id);
    if (!existing) return null;
    const ts = now();
    const merged = { ...existing, ...data };

    this.db.run(sql`
      UPDATE stories SET
        name                 = ${merged.name},
        description          = ${merged.description},
        global_context       = ${merged.globalContext},
        narrative_rules      = ${merged.narrativeRules},
        world_lore           = ${merged.worldLore},
        persistent_events    = ${JSON.stringify(merged.persistentEvents)},
        locations            = ${JSON.stringify(merged.locations ?? [])},
        state_variables      = ${JSON.stringify(merged.stateVariables)},
        behavior_restrictions= ${JSON.stringify(merged.behaviorRestrictions)},
        is_active            = ${merged.isActive ? 1 : 0},
        adventure_mode       = ${merged.adventureMode ? 1 : 0},
        open_world           = ${merged.openWorld ? 1 : 0},
        death_mode           = ${merged.deathMode ? 1 : 0},
        updated_at           = ${ts}
      WHERE id = ${id}
    `);

    if (data.characters !== undefined) {
      this.db.run(sql`DELETE FROM story_characters WHERE story_id = ${id}`);
      for (const c of data.characters) {
        this.db.run(sql`
          INSERT INTO story_characters (story_id, character_id, role, notes)
          VALUES (${id}, ${c.characterId}, ${c.role}, ${c.notes})
        `);
      }
    }

    return this.findById(id)!;
  }

  delete(id: string): boolean {
    this.db.run(sql`DELETE FROM stories WHERE id = ${id}`);
    return true;
  }
}
