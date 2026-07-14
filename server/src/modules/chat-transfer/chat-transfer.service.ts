import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../../db/index.js';
import { ConversationRepository } from '../conversations/conversation.repository.js';
import { NotFoundError, ForbiddenError, ValidationError } from '../../shared/errors.js';
import type { Conversation } from '@rpgspeak/shared';

const __moduleDirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__moduleDirname, '../../../../');
const IMAGES_DIR   = path.join(PROJECT_ROOT, 'data', 'images');

const FORMAT  = 'rpgspeak-chat';
const VERSION = 1;

// Un paquete de chat es autocontenido y portable entre instancias: lleva la
// conversación y TODAS sus dependencias (personajes e historias completas, con
// sus vínculos), más los ficheros de imagen referenciados en base64. Los
// embeddings (context_items.embedding) NO se exportan — se regeneran en destino.
export interface ChatPackage {
  format: typeof FORMAT;
  version: number;
  exportedAt: string;
  conversation: Row;
  conversationCharacters: Row[];
  conversationStories: Row[];
  conversationStoryEvents: Row[];
  messages: Row[];
  memoryEntries: Row[];
  contextItems: Row[];
  summaries: Row[];
  characters: Row[];
  stories: Row[];
  storyCharacters: Row[];
  images: Record<string, string>; // ruta relativa bajo data/images → base64
}

type Row = Record<string, unknown>;
type Runner = { run: (q: ReturnType<typeof sql>) => unknown };

const convRepo = new ConversationRepository();

// ─── SQL helpers ──────────────────────────────────────────────────────────────

/** IN (...) seguro a partir de una lista de valores (vacía → cláusula imposible). */
function inList(ids: string[]) {
  if (ids.length === 0) return sql`(NULL)`;
  return sql`(${sql.join(ids.map((v) => sql`${v}`), sql`, `)})`;
}

function insertRow(runner: Runner, table: string, row: Row): void {
  const cols = Object.keys(row);
  const colSql = sql.raw(cols.map((c) => `"${c}"`).join(', '));
  const vals   = sql.join(cols.map((c) => sql`${row[c] ?? null}`), sql`, `);
  runner.run(sql`INSERT INTO ${sql.raw(table)} (${colSql}) VALUES (${vals})`);
}

/** INSERT … ON CONFLICT(pk) DO UPDATE — actualiza en sitio (no dispara los
 *  DELETE en cascada que provocaría un INSERT OR REPLACE). Gana lo importado. */
function upsertRow(runner: Runner, table: string, row: Row, pk = 'id'): void {
  const cols = Object.keys(row);
  const colSql = sql.raw(cols.map((c) => `"${c}"`).join(', '));
  const vals   = sql.join(cols.map((c) => sql`${row[c] ?? null}`), sql`, `);
  const setSql = sql.raw(
    cols.filter((c) => c !== pk).map((c) => `"${c}" = excluded."${c}"`).join(', ')
  );
  runner.run(
    sql`INSERT INTO ${sql.raw(table)} (${colSql}) VALUES (${vals}) ON CONFLICT(${sql.raw(`"${pk}"`)}) DO UPDATE SET ${setSql}`
  );
}

// ─── Imágenes ─────────────────────────────────────────────────────────────────

const IMG_RE = /\/images\/[A-Za-z0-9_\-./]+\.(?:png|jpe?g|webp|gif)/gi;

/** Recolecta rutas /images/… referenciadas en cualquier campo del paquete y las
 *  empaqueta como base64. Solo ficheros locales existentes bajo data/images. */
function collectImages(pkgWithoutImages: Omit<ChatPackage, 'images'>): Record<string, string> {
  const blob = JSON.stringify(pkgWithoutImages);
  const rels = new Set<string>();
  for (const m of blob.matchAll(IMG_RE)) {
    rels.add(m[0].replace(/^\/images\//, ''));
  }
  const images: Record<string, string> = {};
  for (const rel of rels) {
    // Evita escapes fuera de data/images
    const abs = path.join(IMAGES_DIR, rel);
    if (!abs.startsWith(IMAGES_DIR)) continue;
    try {
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
        images[rel] = fs.readFileSync(abs).toString('base64');
      }
    } catch { /* ignore — imagen ausente, se restaurará sin ella */ }
  }
  return images;
}

function writeImages(images: Record<string, string>): void {
  for (const [rel, b64] of Object.entries(images)) {
    const abs = path.join(IMAGES_DIR, rel);
    if (!abs.startsWith(IMAGES_DIR)) continue;
    try {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, Buffer.from(b64, 'base64'));
    } catch { /* ignore — el chat sigue siendo utilizable sin la imagen */ }
  }
}

// ─── Export ───────────────────────────────────────────────────────────────────

export function exportConversation(
  convId: string,
  requester: { userId?: string; role?: string },
  includeImages = true,
): ChatPackage {
  const db = getDb();

  const conversation = db.get<Row>(sql`SELECT * FROM conversations WHERE id = ${convId}`);
  if (!conversation) throw new NotFoundError('Conversation', convId);

  const isAdmin = requester.role === 'admin';
  const ownerId = conversation.user_id as string | null;
  if (!isAdmin && ownerId && ownerId !== requester.userId) {
    throw new ForbiddenError('No puedes exportar un chat que no es tuyo.');
  }

  const conversationCharacters = db.all<Row>(
    sql`SELECT conversation_id, character_id, "order", affinity FROM conversation_characters WHERE conversation_id = ${convId}`
  );
  const conversationStories = db.all<Row>(
    sql`SELECT conversation_id, story_id, priority FROM conversation_stories WHERE conversation_id = ${convId}`
  );
  const conversationStoryEvents = db.all<Row>(
    sql`SELECT conversation_id, story_id, event_id, occurred_at FROM conversation_story_events WHERE conversation_id = ${convId}`
  );
  const messages  = db.all<Row>(sql`SELECT * FROM messages WHERE conversation_id = ${convId}`);
  const memoryEntries = db.all<Row>(sql`SELECT * FROM memory_entries WHERE conversation_id = ${convId}`);
  // context_items: se excluyen embedding/embedding_model (se regeneran en destino)
  const contextItems = db.all<Row>(sql`
    SELECT id, conversation_id, type, title, description, importance,
           message_index_from, message_index_to, is_active, created_at, updated_at
    FROM context_items WHERE conversation_id = ${convId}`);
  const summaries = db.all<Row>(sql`SELECT * FROM conversation_summaries WHERE conversation_id = ${convId}`);

  const storyIds = conversationStories.map((r) => String(r.story_id));
  const stories = storyIds.length
    ? db.all<Row>(sql`SELECT * FROM stories WHERE id IN ${inList(storyIds)}`)
    : [];
  const storyCharacters = storyIds.length
    ? db.all<Row>(sql`SELECT story_id, character_id, role, notes FROM story_characters WHERE story_id IN ${inList(storyIds)}`)
    : [];

  // Personajes: los del chat + los referenciados por las historias + el activo +
  // los que aparecen como autor de algún mensaje.
  const charIds = new Set<string>();
  for (const r of conversationCharacters) charIds.add(String(r.character_id));
  for (const r of storyCharacters)        charIds.add(String(r.character_id));
  if (conversation.active_character_id) charIds.add(String(conversation.active_character_id));
  for (const m of messages) if (m.character_id) charIds.add(String(m.character_id));
  const charIdList = [...charIds];
  const characters = charIdList.length
    ? db.all<Row>(sql`SELECT * FROM characters WHERE id IN ${inList(charIdList)}`)
    : [];

  const base: Omit<ChatPackage, 'images'> = {
    format: FORMAT,
    version: VERSION,
    exportedAt: new Date().toISOString(),
    conversation,
    conversationCharacters,
    conversationStories,
    conversationStoryEvents,
    messages,
    memoryEntries,
    contextItems,
    summaries,
    characters,
    stories,
    storyCharacters,
  };

  const images = includeImages ? collectImages(base) : {};
  return { ...base, images };
}

// ─── Import ───────────────────────────────────────────────────────────────────

export function importConversation(pkg: ChatPackage, userId: string | null): Conversation {
  if (!pkg || pkg.format !== FORMAT) {
    throw new ValidationError('El archivo no es un paquete de chat de rpgSpeak.');
  }
  if (pkg.version > VERSION) {
    throw new ValidationError(`Paquete creado con una versión más reciente (v${pkg.version}). Actualiza la aplicación.`);
  }
  if (!pkg.conversation || typeof pkg.conversation !== 'object') {
    throw new ValidationError('El paquete no contiene ninguna conversación.');
  }

  const db = getDb();
  const nowIso = new Date().toISOString();
  const newConvId = uuidv4();

  db.transaction((tx) => {
    // 1. Personajes e historias — upsert (gana lo importado), reasignados al importador.
    const importedCharIds = new Set<string>();
    for (const c of pkg.characters ?? []) {
      const row: Row = { ...c, user_id: userId };
      upsertRow(tx as unknown as Runner, 'characters', row);
      importedCharIds.add(String(c.id));
    }
    const importedStoryIds = new Set<string>();
    for (const s of pkg.stories ?? []) {
      const row: Row = { ...s, user_id: userId };
      upsertRow(tx as unknown as Runner, 'stories', row);
      importedStoryIds.add(String(s.id));
    }

    // story_characters: la historia importada dicta su reparto (borra + reinserta).
    for (const sid of importedStoryIds) {
      tx.run(sql`DELETE FROM story_characters WHERE story_id = ${sid}`);
    }
    for (const sc of pkg.storyCharacters ?? []) {
      if (!importedStoryIds.has(String(sc.story_id))) continue;
      if (!importedCharIds.has(String(sc.character_id))) continue; // evita violar la FK
      insertRow(tx as unknown as Runner, 'story_characters', { ...sc });
    }

    // 2. La conversación — id NUEVO siempre (permite reimportar sin pisar nada),
    //    propiedad del importador.
    const conv = pkg.conversation;
    insertRow(tx as unknown as Runner, 'conversations', {
      id: newConvId,
      title: conv.title ?? 'Chat importado',
      summary: conv.summary ?? null,
      current_location: conv.current_location ?? null,
      mode: conv.mode ?? 'single',
      active_character_id: conv.active_character_id ?? null,
      is_archived: 0,
      token_count: conv.token_count ?? 0,
      message_count: conv.message_count ?? 0,
      metadata: conv.metadata ?? '{}',
      user_id: userId,
      created_at: conv.created_at ?? nowIso,
      updated_at: nowIso,
    });

    // 3. Vínculos de la conversación (filtrados a lo que existe → sin romper FKs).
    for (const cc of pkg.conversationCharacters ?? []) {
      if (!importedCharIds.has(String(cc.character_id))) continue;
      insertRow(tx as unknown as Runner, 'conversation_characters', {
        conversation_id: newConvId,
        character_id: cc.character_id,
        order: cc.order ?? 0,
        affinity: cc.affinity ?? 50,
      });
    }
    for (const cs of pkg.conversationStories ?? []) {
      if (!importedStoryIds.has(String(cs.story_id))) continue;
      insertRow(tx as unknown as Runner, 'conversation_stories', {
        conversation_id: newConvId,
        story_id: cs.story_id,
        priority: cs.priority ?? 0,
      });
    }
    for (const ev of pkg.conversationStoryEvents ?? []) {
      if (!importedStoryIds.has(String(ev.story_id))) continue;
      insertRow(tx as unknown as Runner, 'conversation_story_events', {
        conversation_id: newConvId,
        story_id: ev.story_id,
        event_id: ev.event_id,
        occurred_at: ev.occurred_at ?? nowIso,
      });
    }

    // 4. Mensajes — ids remapeados (evita colisión al reimportar); parent_id se
    //    reescribe con el mapa; branch_id es una etiqueta, se conserva.
    const idMap = new Map<string, string>();
    for (const m of pkg.messages ?? []) idMap.set(String(m.id), uuidv4());
    for (const m of pkg.messages ?? []) {
      const parent = m.parent_id ? (idMap.get(String(m.parent_id)) ?? null) : null;
      insertRow(tx as unknown as Runner, 'messages', {
        id: idMap.get(String(m.id)),
        conversation_id: newConvId,
        parent_id: parent,
        branch_id: m.branch_id ?? 'main',
        role: m.role,
        content: m.content,
        character_id: m.character_id ?? null,
        tokens: m.tokens ?? 0,
        is_active: m.is_active ?? 1,
        metadata: m.metadata ?? '{}',
        created_at: m.created_at ?? nowIso,
        updated_at: m.updated_at ?? nowIso,
      });
    }

    // 5. Memoria, contexto y resúmenes — ids nuevos, colgados de la nueva conv.
    for (const me of pkg.memoryEntries ?? []) {
      insertRow(tx as unknown as Runner, 'memory_entries', {
        id: uuidv4(),
        conversation_id: newConvId,
        character_id: me.character_id ?? null,
        type: me.type ?? 'fact',
        content: me.content,
        importance: me.importance ?? 5,
        is_active: me.is_active ?? 1,
        created_at: me.created_at ?? nowIso,
        updated_at: me.updated_at ?? nowIso,
      });
    }
    for (const ci of pkg.contextItems ?? []) {
      insertRow(tx as unknown as Runner, 'context_items', {
        id: uuidv4(),
        conversation_id: newConvId,
        type: ci.type,
        title: ci.title,
        description: ci.description ?? '',
        importance: ci.importance ?? 5,
        message_index_from: ci.message_index_from ?? 0,
        message_index_to: ci.message_index_to ?? 0,
        is_active: ci.is_active ?? 1,
        created_at: ci.created_at ?? nowIso,
        updated_at: ci.updated_at ?? nowIso,
      });
    }
    for (const su of pkg.summaries ?? []) {
      insertRow(tx as unknown as Runner, 'conversation_summaries', {
        id: uuidv4(),
        conversation_id: newConvId,
        content: su.content,
        message_index_from: su.message_index_from ?? 0,
        message_index_to: su.message_index_to ?? 0,
        created_at: su.created_at ?? nowIso,
      });
    }
  });

  // 6. Imágenes fuera de la transacción de BD (el sistema de ficheros no es
  //    transaccional; si algo falla arriba, no dejamos ficheros huérfanos).
  if (pkg.images) writeImages(pkg.images);

  return convRepo.findById(newConvId)!;
}
