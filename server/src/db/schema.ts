import { sqliteTable, text, integer, real, blob, primaryKey } from 'drizzle-orm/sqlite-core';

// ─── Users ────────────────────────────────────────────────────────────────────

export const users = sqliteTable('users', {
  id:              text('id').primaryKey(),
  username:        text('username').notNull().unique(),
  passwordHash:    text('password_hash').notNull(),
  displayName:     text('display_name').notNull(),
  appearance:      text('appearance').notNull().default(''),  // visual description for image generation
  role:            text('role').notNull().default('user'), // 'admin' | 'user'
  isActive:        integer('is_active', { mode: 'boolean' }).notNull().default(true),
  narrationStyle:  text('narration_style').notNull().default('normal'), // 'normal' | 'medium' | 'short'
  createdAt:       text('created_at').notNull(),
  updatedAt:       text('updated_at').notNull(),
});

export type DbUser = typeof users.$inferSelect;

// ─── Characters ───────────────────────────────────────────────────────────────

export const characters = sqliteTable('characters', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  avatar: text('avatar'),
  description: text('description').notNull().default(''),
  personality: text('personality').notNull().default(''),
  systemPrompt: text('system_prompt').notNull().default(''),
  lore: text('lore').notNull().default(''),
  exampleDialogue: text('example_dialogue').notNull().default('[]'), // JSON
  tags: text('tags').notNull().default('[]'),                         // JSON
  temperature: real('temperature').notNull().default(0.8),
  modelId: text('model_id'),
  providerId: text('provider_id'),
  contextLength: integer('context_length').notNull().default(4096),
  memoryEnabled: integer('memory_enabled', { mode: 'boolean' }).notNull().default(true),
  memoryType: text('memory_type').notNull().default('rolling'), // rolling | summary | none
  memoryWindow: integer('memory_window').notNull().default(20),
  llmParams: text('llm_params').notNull().default('{}'),            // JSON
  relations: text('relations').notNull().default('[]'),              // JSON
  rpgStats: text('rpg_stats').default('{}'),
  imageDescription: text('image_description'),
  gallery: text('gallery').notNull().default('[]'), // JSON array of image paths
  userId: text('user_id'),  // owner; NULL = shared/legacy
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

// ─── Stories ──────────────────────────────────────────────────────────────────

export const stories = sqliteTable('stories', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  globalContext: text('global_context').notNull().default(''),
  narrativeRules: text('narrative_rules').notNull().default(''),
  worldLore: text('world_lore').notNull().default(''),
  persistentEvents: text('persistent_events').notNull().default('[]'), // JSON
  locations: text('locations').notNull().default('[]'),                  // JSON
  stateVariables: text('state_variables').notNull().default('{}'),      // JSON
  behaviorRestrictions: text('behavior_restrictions').notNull().default('[]'), // JSON
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(false),
  adventureMode: integer('adventure_mode', { mode: 'boolean' }).default(false),
  openWorld: integer('open_world', { mode: 'boolean' }).default(false),
  deathMode: integer('death_mode', { mode: 'boolean' }).default(false),
  userId: text('user_id'),  // owner; NULL = shared/legacy
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const storyCharacters = sqliteTable(
  'story_characters',
  {
    storyId: text('story_id')
      .notNull()
      .references(() => stories.id, { onDelete: 'cascade' }),
    characterId: text('character_id')
      .notNull()
      .references(() => characters.id, { onDelete: 'cascade' }),
    role: text('role').notNull().default(''),
    notes: text('notes').notNull().default(''),
  },
  (t) => ({ pk: primaryKey({ columns: [t.storyId, t.characterId] }) })
);

// ─── Conversations ────────────────────────────────────────────────────────────

export const conversations = sqliteTable('conversations', {
  id: text('id').primaryKey(),
  title: text('title').notNull().default('New Conversation'),
  summary: text('summary'),
  currentLocation: text('current_location'),             // active scene location (nullable)
  mode: text('mode').notNull().default('single'), // single | group | story
  activeCharacterId: text('active_character_id'),
  isArchived: integer('is_archived', { mode: 'boolean' }).notNull().default(false),
  tokenCount: integer('token_count').notNull().default(0),
  messageCount: integer('message_count').notNull().default(0),
  metadata: text('metadata').notNull().default('{}'), // JSON
  userId: text('user_id'),  // owner; NULL = shared/legacy
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const conversationCharacters = sqliteTable(
  'conversation_characters',
  {
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    characterId: text('character_id')
      .notNull()
      .references(() => characters.id, { onDelete: 'cascade' }),
    order:    integer('order').notNull().default(0),
    affinity: integer('affinity').notNull().default(50),
  },
  (t) => ({ pk: primaryKey({ columns: [t.conversationId, t.characterId] }) })
);

export const conversationStories = sqliteTable(
  'conversation_stories',
  {
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    storyId: text('story_id')
      .notNull()
      .references(() => stories.id, { onDelete: 'cascade' }),
    priority: integer('priority').notNull().default(0),
  },
  (t) => ({ pk: primaryKey({ columns: [t.conversationId, t.storyId] }) })
);

// Estado por conversación de los eventos de historia (persistent_events):
// una fila = el evento ya OCURRIÓ narrativamente en esa conversación.
// Sin fila = pendiente. El event_id referencia el id dentro del JSON
// stories.persistent_events (no hay FK posible a un campo JSON).
export const conversationStoryEvents = sqliteTable(
  'conversation_story_events',
  {
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    storyId: text('story_id')
      .notNull()
      .references(() => stories.id, { onDelete: 'cascade' }),
    eventId: text('event_id').notNull(),
    occurredAt: text('occurred_at').notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.conversationId, t.eventId] }) })
);

// ─── Messages ─────────────────────────────────────────────────────────────────

export const messages = sqliteTable('messages', {
  id: text('id').primaryKey(),
  conversationId: text('conversation_id')
    .notNull()
    .references(() => conversations.id, { onDelete: 'cascade' }),
  parentId: text('parent_id'), // self-ref for branching — no FK to allow null
  branchId: text('branch_id').notNull().default('main'),
  role: text('role').notNull(), // user | assistant | system
  content: text('content').notNull(),
  characterId: text('character_id'), // which character responded
  tokens: integer('tokens').notNull().default(0),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  metadata: text('metadata').notNull().default('{}'), // JSON
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

// ─── Memory ───────────────────────────────────────────────────────────────────

export const memoryEntries = sqliteTable('memory_entries', {
  id: text('id').primaryKey(),
  conversationId: text('conversation_id')
    .notNull()
    .references(() => conversations.id, { onDelete: 'cascade' }),
  characterId: text('character_id'),
  type: text('type').notNull().default('fact'), // fact | event | relationship | preference | summary
  content: text('content').notNull(),
  importance: integer('importance').notNull().default(5), // 1-10
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

// ─── Providers ────────────────────────────────────────────────────────────────

export const providers = sqliteTable('providers', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  type: text('type').notNull(), // ollama | openai | lmstudio | kobold | oobabooga | openrouter | custom
  baseUrl: text('base_url').notNull(),
  apiKey: text('api_key'),
  defaultModel: text('default_model'),
  isEnabled: integer('is_enabled', { mode: 'boolean' }).notNull().default(true),
  config: text('config').notNull().default('{}'), // JSON
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

// ─── Settings ─────────────────────────────────────────────────────────────────

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: text('updated_at').notNull(),
});

// ─── User content assignments ─────────────────────────────────────────────────
// Admin can grant non-admin users access to specific characters and stories.
// A user always sees their own (userId = me); these tables add extra visibility.

export const userCharacters = sqliteTable(
  'user_characters',
  {
    userId:      text('user_id').notNull(),
    characterId: text('character_id').notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.userId, t.characterId] }) })
);

export const userStories = sqliteTable(
  'user_stories',
  {
    userId:  text('user_id').notNull(),
    storyId: text('story_id').notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.userId, t.storyId] }) })
);

// ─── Context Items ────────────────────────────────────────────────────────────

export const contextItems = sqliteTable('context_items', {
  id:               text('id').primaryKey(),
  conversationId:   text('conversation_id').notNull().references(() => conversations.id, { onDelete: 'cascade' }),
  type:             text('type').notNull(),   // 'event' | 'character' | 'place' | 'quest'
  title:            text('title').notNull(),
  description:      text('description').notNull().default(''),
  importance:       integer('importance').notNull().default(5),
  messageIndexFrom: integer('message_index_from').notNull().default(0),
  messageIndexTo:   integer('message_index_to').notNull().default(0),
  isActive:         integer('is_active', { mode: 'boolean' }).notNull().default(true),
  embedding:        blob('embedding'),          // Float32Array bytes, nullable
  embeddingModel:   text('embedding_model'),    // e.g. "nomic-embed-text", nullable
  createdAt:        text('created_at').notNull(),
  updatedAt:        text('updated_at').notNull(),
});

// ─── Type exports for Drizzle inference ───────────────────────────────────────

// ─── Conversation Summaries (historial acumulativo) ──────────────────────────

export const conversationSummaries = sqliteTable('conversation_summaries', {
  id:               text('id').primaryKey(),
  conversationId:   text('conversation_id').notNull().references(() => conversations.id, { onDelete: 'cascade' }),
  content:          text('content').notNull(),
  messageIndexFrom: integer('message_index_from').notNull().default(0),
  messageIndexTo:   integer('message_index_to').notNull().default(0),
  createdAt:        text('created_at').notNull(),
});

export type DbConversationSummary = typeof conversationSummaries.$inferSelect;

export type DbContextItem = typeof contextItems.$inferSelect;
export type DbCharacter = typeof characters.$inferSelect;
export type DbStory = typeof stories.$inferSelect;
export type DbConversation = typeof conversations.$inferSelect;
export type DbMessage = typeof messages.$inferSelect;
export type DbMemoryEntry = typeof memoryEntries.$inferSelect;
export type DbProvider = typeof providers.$inferSelect;
export type DbSetting = typeof settings.$inferSelect;
