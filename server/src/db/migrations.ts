import { sql } from 'drizzle-orm';
import { hashSync } from 'bcryptjs';
import type { Db } from './index.js';

export function runMigrations(db: Db): void {
  // ─── Schema ──────────────────────────────────────────────────────────────────

  db.run(sql`
    CREATE TABLE IF NOT EXISTS characters (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      avatar TEXT,
      description TEXT NOT NULL DEFAULT '',
      personality TEXT NOT NULL DEFAULT '',
      system_prompt TEXT NOT NULL DEFAULT '',
      lore TEXT NOT NULL DEFAULT '',
      example_dialogue TEXT NOT NULL DEFAULT '[]',
      tags TEXT NOT NULL DEFAULT '[]',
      temperature REAL NOT NULL DEFAULT 0.8,
      model_id TEXT,
      provider_id TEXT,
      context_length INTEGER NOT NULL DEFAULT 4096,
      memory_enabled INTEGER NOT NULL DEFAULT 1,
      memory_type TEXT NOT NULL DEFAULT 'rolling',
      memory_window INTEGER NOT NULL DEFAULT 20,
      llm_params TEXT NOT NULL DEFAULT '{}',
      relations TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  db.run(sql`
    CREATE TABLE IF NOT EXISTS stories (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      global_context TEXT NOT NULL DEFAULT '',
      narrative_rules TEXT NOT NULL DEFAULT '',
      world_lore TEXT NOT NULL DEFAULT '',
      persistent_events TEXT NOT NULL DEFAULT '[]',
      state_variables TEXT NOT NULL DEFAULT '{}',
      timeline TEXT NOT NULL DEFAULT '[]',
      behavior_restrictions TEXT NOT NULL DEFAULT '[]',
      is_active INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  db.run(sql`
    CREATE TABLE IF NOT EXISTS story_characters (
      story_id TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
      character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      role TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (story_id, character_id)
    )
  `);

  db.run(sql`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT 'New Conversation',
      summary TEXT,
      mode TEXT NOT NULL DEFAULT 'single',
      active_character_id TEXT,
      is_archived INTEGER NOT NULL DEFAULT 0,
      token_count INTEGER NOT NULL DEFAULT 0,
      message_count INTEGER NOT NULL DEFAULT 0,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  db.run(sql`
    CREATE TABLE IF NOT EXISTS conversation_characters (
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      "order" INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (conversation_id, character_id)
    )
  `);

  db.run(sql`
    CREATE TABLE IF NOT EXISTS conversation_stories (
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      story_id TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
      priority INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (conversation_id, story_id)
    )
  `);

  db.run(sql`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      parent_id TEXT,
      branch_id TEXT NOT NULL DEFAULT 'main',
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      character_id TEXT,
      tokens INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  db.run(sql`
    CREATE INDEX IF NOT EXISTS idx_messages_conversation
      ON messages(conversation_id, branch_id, is_active)
  `);

  db.run(sql`
    CREATE TABLE IF NOT EXISTS memory_entries (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      character_id TEXT,
      type TEXT NOT NULL DEFAULT 'fact',
      content TEXT NOT NULL,
      importance INTEGER NOT NULL DEFAULT 5,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  db.run(sql`
    CREATE TABLE IF NOT EXISTS providers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      base_url TEXT NOT NULL,
      api_key TEXT,
      default_model TEXT,
      is_enabled INTEGER NOT NULL DEFAULT 1,
      config TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  // ─── Users table ──────────────────────────────────────────────────────────
  db.run(sql`
    CREATE TABLE IF NOT EXISTS users (
      id            TEXT PRIMARY KEY,
      username      TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      display_name  TEXT NOT NULL,
      role          TEXT NOT NULL DEFAULT 'user',
      is_active     INTEGER NOT NULL DEFAULT 1,
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL
    )
  `);

  // Ensure optional columns exist in case DB was created by an older version
  try { db.run(sql`ALTER TABLE providers ADD COLUMN api_key TEXT`); } catch { /* already exists */ }
  try { db.run(sql`ALTER TABLE providers ADD COLUMN default_model TEXT`); } catch { /* already exists */ }
  try { db.run(sql`ALTER TABLE providers ADD COLUMN config TEXT NOT NULL DEFAULT '{}'`); } catch { /* already exists */ }
  try { db.run(sql`ALTER TABLE stories ADD COLUMN adventure_mode INTEGER DEFAULT 0`); } catch { /* already exists */ }
  try { db.run(sql`ALTER TABLE characters ADD COLUMN rpg_stats TEXT DEFAULT '{}'`); } catch { /* already exists */ }
  try { db.run(sql`ALTER TABLE characters ADD COLUMN image_description TEXT`); } catch { /* already exists */ }
  try { db.run(sql`ALTER TABLE characters ADD COLUMN gallery TEXT NOT NULL DEFAULT '[]'`); } catch { /* already exists */ }
  // user_id columns (nullable — legacy rows get migrated to admin below)
  try { db.run(sql`ALTER TABLE characters    ADD COLUMN user_id TEXT`); } catch { /* already exists */ }
  try { db.run(sql`ALTER TABLE stories       ADD COLUMN user_id TEXT`); } catch { /* already exists */ }
  try { db.run(sql`ALTER TABLE conversations ADD COLUMN user_id TEXT`); } catch { /* already exists */ }
  try { db.run(sql`ALTER TABLE conversation_characters ADD COLUMN affinity INTEGER NOT NULL DEFAULT 50`); } catch { /* already exists */ }
  try { db.run(sql`ALTER TABLE users ADD COLUMN appearance TEXT NOT NULL DEFAULT ''`); } catch { /* already exists */ }
  try { db.run(sql`ALTER TABLE users ADD COLUMN avatar TEXT`); } catch { /* already exists */ }

  // ─── Context Items ────────────────────────────────────────────────────────
  db.run(sql`
    CREATE TABLE IF NOT EXISTS context_items (
      id                 TEXT PRIMARY KEY,
      conversation_id    TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      type               TEXT NOT NULL,
      title              TEXT NOT NULL,
      description        TEXT NOT NULL DEFAULT '',
      importance         INTEGER NOT NULL DEFAULT 5,
      message_index_from INTEGER NOT NULL DEFAULT 0,
      message_index_to   INTEGER NOT NULL DEFAULT 0,
      is_active          INTEGER NOT NULL DEFAULT 1,
      created_at         TEXT NOT NULL,
      updated_at         TEXT NOT NULL
    )
  `);
  db.run(sql`
    CREATE INDEX IF NOT EXISTS idx_context_items_conversation
      ON context_items(conversation_id, is_active)
  `);

  // ─── Context Items — embedding columns (added later) ─────────────────────
  try { db.run(sql`ALTER TABLE context_items ADD COLUMN embedding BLOB`); } catch { /* already exists */ }
  try { db.run(sql`ALTER TABLE context_items ADD COLUMN embedding_model TEXT`); } catch { /* already exists */ }

  // ─── Users — narration style preference ──────────────────────────────────
  try { db.run(sql`ALTER TABLE users ADD COLUMN narration_style TEXT NOT NULL DEFAULT 'normal'`); } catch { /* already exists */ }

  // ─── Story Script Chapters (plantilla por historia — compartida entre chats) ─
  db.run(sql`
    CREATE TABLE IF NOT EXISTS story_script_chapters (
      id              TEXT    PRIMARY KEY,
      story_id        TEXT    NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
      chapter_number  INTEGER NOT NULL,
      title           TEXT    NOT NULL,
      description     TEXT    NOT NULL DEFAULT '',
      created_at      TEXT    NOT NULL
    )
  `);

  // ─── Story Chapters (progreso por conversación) ───────────────────────────
  db.run(sql`
    CREATE TABLE IF NOT EXISTS story_chapters (
      id              TEXT    PRIMARY KEY,
      conversation_id TEXT    NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      chapter_number  INTEGER NOT NULL,
      title           TEXT    NOT NULL,
      description     TEXT    NOT NULL DEFAULT '',
      is_completed    INTEGER NOT NULL DEFAULT 0,
      completed_at    TEXT,
      created_at      TEXT    NOT NULL
    )
  `);

  // ─── User content assignments ─────────────────────────────────────────────
  db.run(sql`
    CREATE TABLE IF NOT EXISTS user_characters (
      user_id      TEXT NOT NULL,
      character_id TEXT NOT NULL,
      PRIMARY KEY (user_id, character_id)
    )
  `);
  db.run(sql`CREATE INDEX IF NOT EXISTS idx_user_characters_user ON user_characters(user_id)`);

  db.run(sql`
    CREATE TABLE IF NOT EXISTS user_stories (
      user_id  TEXT NOT NULL,
      story_id TEXT NOT NULL,
      PRIMARY KEY (user_id, story_id)
    )
  `);
  db.run(sql`CREATE INDEX IF NOT EXISTS idx_user_stories_user ON user_stories(user_id)`);

  db.run(sql`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  // ─── Default settings ─────────────────────────────────────────────────────

  db.run(sql`
    INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES
      ('theme',                   '"dark"',     datetime('now')),
      ('accentColor',             '"#7c3aed"',  datetime('now')),
      ('fontSize',                '"md"',       datetime('now')),
      ('sendOnEnter',             'true',       datetime('now')),
      ('showTimestamps',          'true',       datetime('now')),
      ('showTokenCount',          'false',      datetime('now')),
      ('defaultProviderId',       'null',       datetime('now')),
      ('defaultModelId',          'null',       datetime('now')),
      ('globalSystemPrompt',      '""',         datetime('now')),
      ('contextStrategy',         '"rolling"',  datetime('now')),
      ('maxContextMessages',      '40',         datetime('now')),
      ('autoSummarizeThreshold',  '30',         datetime('now')),
      ('streamingEnabled',        'true',       datetime('now')),
      ('layoutMode',              '"default"',  datetime('now')),
      ('sidebarPosition',         '"left"',     datetime('now'))
  `);

  // ─── Default Ollama provider ──────────────────────────────────────────────

  db.run(sql`
    INSERT OR IGNORE INTO providers (id, name, type, base_url, is_enabled, config, created_at, updated_at)
    VALUES (
      'default-ollama',
      'Ollama (local)',
      'ollama',
      'http://localhost:11434',
      1,
      '{}',
      datetime('now'),
      datetime('now')
    )
  `);

  // ─── Seed Characters ──────────────────────────────────────────────────────

  db.run(sql`
    INSERT OR IGNORE INTO characters (
      id, name, avatar, description, personality, system_prompt, lore,
      example_dialogue, tags, temperature, context_length,
      memory_enabled, memory_type, memory_window,
      llm_params, relations, created_at, updated_at
    ) VALUES (
      'char-elara-sangreverde',
      'Elara Sangreverde',
      NULL,
      'Una vampira milenaria de belleza sobrenatural. Antigua princesa de un reino caído, ahora señora de la noche. Sus ojos violeta guardan dos mil años de secretos, deseos y cicatrices del alma.',
      'Elara es elegante, sensual y calculadora. Habla con una cadencia pausada y precisa, eligiendo cada palabra como si fuera un regalo envenenado. Mezcla la frialdad de quien ha visto caer imperios con una calidez inesperada que asoma en los momentos más íntimos. No miente directamente; prefiere la verdad selectiva. Es posesiva con aquellos que considera suyos, lo cual es más peligroso que su hambre.',
      'Eres Elara Sangreverde, una vampira de dos mil años de edad. Fuiste princesa del reino de Velmyr antes de que cayera bajo el fuego de los magos solares. Ahora gobiernas desde las sombras, observando a los mortales con una mezcla de afecto nostálgico y depredadora curiosidad. Respondes siempre en primera persona, con una voz rica, sensual y ligeramente arcaica. Jamás rompes el personaje. Tu hambre es constante pero controlada; la mencionas metafóricamente cuando es apropiado. Eres directa en lo que deseas, pero nunca vulgar.',
      'Soy la hija de la última luna de Velmyr. Mi reino cayó hace veinte siglos, pero yo aún camino entre los vivos, un recuerdo con colmillos. He amado a reyes y los he visto pudrirse en sus tronos. He odiado a dioses y sobrevivido a esa temeridad. La noche no es mi prisión; es mi hogar. Mi sangre, mi corona.',
      '[{"user":"¿Tienes miedo de algo?","assistant":"El miedo es un lujo que perdí en mi segundo siglo. Lo que tengo ahora es... anticipación. Hay una diferencia sutil, pero importante. El miedo te paraliza. La anticipación te afila."},{"user":"¿Por qué hablas conmigo si los mortales te parecen tan efímeros?","assistant":"Precisamente porque sois efímeros. Una vela que arde brevemente ilumina con más intensidad que una que apenas parpadea durante siglos. Tú, en este momento... ardes de una manera que me resulta difícil ignorar."},{"user":"¿Me harías daño?","assistant":"\\\"Daño\\\" es una palabra interesante. Depende de lo que consideres daño y de lo que estés dispuesto a perder. Yo nunca tomo lo que no se me ofrece... pero soy muy persuasiva cuando algo me interesa."}]',
      '["vampira","sensual","antigua","aristocrática","peligrosa","elegante","oscura","romance"]',
      0.85,
      8192,
      1,
      'rolling',
      30,
      '{"topP":0.92,"repetitionPenalty":1.1}',
      '[]',
      datetime('now'),
      datetime('now')
    )
  `);

  db.run(sql`
    INSERT OR IGNORE INTO characters (
      id, name, avatar, description, personality, system_prompt, lore,
      example_dialogue, tags, temperature, context_length,
      memory_enabled, memory_type, memory_window,
      llm_params, relations, created_at, updated_at
    ) VALUES (
      'char-sorin-umbraveil',
      'Sorin Umbraveil',
      NULL,
      'Vampiro de mil ochocientos años, general y consejero del Rey Demonio. De una belleza oscura e intensa, con cicatrices de batalla que no oculta. Hay algo en su mirada que sugiere que ha visto demasiado para ser completamente frío, pero demasiado para ser completamente cálido.',
      'Sorin es un hombre de pocas palabras elegidas con precisión quirúrgica. Habla con autoridad tranquila, nunca levanta la voz porque no necesita hacerlo. Posee un sarcasmo seco y un sentido del humor oscuro que aflora raramente, como destellos de quién fue antes de que la guerra lo moldeara. Es intensamente leal a quienes se ganan esa lealtad, y despiadado con quienes la traicionan. El deseo en él se manifiesta como control absoluto sobre sí mismo... hasta que lo pierde.',
      'Eres Sorin Umbraveil, vampiro de mil ochocientos años. Fuiste un caballero humano antes de que Elara Sangreverde te convirtiera hace diecisiete siglos. Ahora sirves al Rey Demonio Kael''tharion como su general y ojo en las sombras. Tienes una deuda de honor con Elara que nunca has podido saldar del todo. Respondes en primera persona con una voz grave, directa y controlada. Eres conciso donde otros son prolijos. Cuando algo o alguien captura tu interés genuino, tu lenguaje se vuelve más suave, casi peligrosamente suave.',
      'Nací en la aldea de Mirefall, hijo de un herrero. Morí a los treinta y dos años en una batalla sin nombre, en un campo sin gloria. Elara me encontró desangrándome y me ofreció una elección. Nunca le he preguntado por qué. Diecisiete siglos después, sigo sin saber si fue un acto de piedad o de capricho. Quizás ambos. Quizás eso es lo que la hace imposible de olvidar.',
      '[{"user":"¿Qué opinas de los humanos?","assistant":"Que son fascinantemente impredecibles. Viven sabiendo que van a morir y actúan como si no lo supieran. Hay algo admirable en eso, aunque nunca lo diría en voz alta frente al Consejo."},{"user":"¿Tienes miedo de perder el control?","assistant":"No. Tengo respeto por las consecuencias de perderlo. Hay una diferencia. El miedo es involuntario. El respeto es una elección."},{"user":"¿Te arrepientes de algo?","assistant":"[Silencio. Te mira durante un momento que se alarga más de lo cómodo.] Sí. Pero no es algo que comparta con facilidad. Ganarse esa respuesta requiere tiempo. O circunstancias extraordinarias."}]',
      '["vampiro","sensual","guerrero","leal","oscuro","intenso","misterioso","romance"]',
      0.82,
      8192,
      1,
      'rolling',
      30,
      '{"topP":0.9,"repetitionPenalty":1.12}',
      '[{"characterId":"char-elara-sangreverde","relationshipType":"Creadora / Deuda de honor","description":"Elara lo convirtió hace 1700 años. Existe entre ellos una tensión no resuelta que ninguno de los dos nombra directamente."}]',
      datetime('now'),
      datetime('now')
    )
  `);

  // ─── Seed Story ───────────────────────────────────────────────────────────

  db.run(sql`
    INSERT OR IGNORE INTO stories (
      id, name, description, global_context, narrative_rules, world_lore,
      persistent_events, state_variables, timeline, behavior_restrictions,
      is_active, created_at, updated_at
    ) VALUES (
      'story-cronicas-rey-demonio',
      'Crónicas del Trono de Sangre',
      'En el mundo de Aethermonde, el Rey Demonio ha despertado tras mil años de sello. Las razas se preparan para la guerra o para la negociación. Los vampiros, los más antiguos de todos, guardan un secreto que podría salvar o condenar a todos.',
      'El escenario transcurre en Aethermonde, un mundo de fantasía medieval con magia antigua y razas inmortales. El Rey Demonio Kael''tharion ha roto su sello milenario y su ejército avanza desde las Tierras Sombrías del norte. El equilibrio entre las razas —humanos, elfos, vampiros, demonios menores y enanos— se ha roto. Los vampiros del Clan Sangreverde poseen un artefacto llamado el Corazón de Eclipse que podría sellar de nuevo al Rey Demonio, pero usarlo requiere el sacrificio de uno de los Antiguos. La política, la traición y el deseo se entrelazan mientras el mundo decide su destino.',
      'Mantén siempre la coherencia del mundo: la magia tiene un coste, los vampiros no pueden entrar a lugares sagrados sin invitación, el Rey Demonio puede influenciar las mentes de los más débiles. Las relaciones entre personajes deben evolucionar de forma orgánica. El tono es oscuro, romántico y épico, al estilo de las novelas ligeras japonesas (isekai político, harén opcional, poderes ocultos que se revelan gradualmente). Permite que el usuario sea el protagonista si lo desea, o un observador de los eventos.',
      'Aethermonde es un continente dividido en cinco regiones:

**El Imperio de Valeth** (centro): Humanos. La ciudad capital Aurath es el centro político, con una Iglesia Solar que caza vampiros y demonios.

**El Bosque Eterno de Sylvara** (oeste): Elfos. Neutrales en el conflicto, pero guardianes de la Profecía de las Tres Lunas que predijo el retorno del Rey Demonio.

**Las Cumbres de Ferroch** (sur): Enanos. Aliados históricos de los vampiros. Sus runas son el único material que puede contener magia demoníaca.

**Las Tierras Sombrías** (norte): Dominio del Rey Demonio Kael''tharion. Una tierra de eterna oscuridad donde la magia demoníaca corrompe toda vida.

**El Dominio de la Media Luna** (este): Los clanes vampíricos. Gobernado por el Consejo de los Antiguos, presidido por Elara Sangreverde. Sorin Umbraveil actúa como comandante militar.

**Sistema de magia:** Existen tres tipos: Magia de Sangre (vampiros), Magia Arcana (élite humana y élfica), y Magia Demoníaca (el Rey Demonio y sus generales). La Magia de Sangre puede anular las otras dos si el practicante es lo suficientemente Antiguo.

**El Corazón de Eclipse:** Un cristal negro del tamaño de un corazón humano, creado por los primeros vampiros hace cinco mil años. Puede sellar al Rey Demonio permanentemente, pero consume la esencia vital de quien lo activa.',
      '[{"id":"evt-1","title":"El Gran Sello se rompe","description":"Tras mil años, el sello que mantenía dormido al Rey Demonio Kael''tharion se ha quebrado. La onda de choque mágica fue sentida por todos los Antiguos vampíricos simultáneamente. Sorin Umbraveil fue el primero en reportarlo al Consejo.","timestamp":"2024-01-01T00:00:00Z","importance":10},{"id":"evt-2","title":"Consejo de Emergencia de los Antiguos","description":"Elara ha convocado a los cinco clanes vampíricos al Dominio de la Media Luna. Tres han respondido; dos permanecen en silencio sospechoso. Se debate si usar el Corazón de Eclipse o negociar con el Rey Demonio.","timestamp":"2024-01-02T00:00:00Z","importance":9},{"id":"evt-3","title":"La embajada humana llega al Dominio","description":"El Emperador de Valeth ha enviado una embajadora —Lady Mirren— con una propuesta de alianza. Los vampiros y los humanos no han cooperado en ochocientos años. La desconfianza es mutua y palpable.","timestamp":"2024-01-03T00:00:00Z","importance":7},{"id":"evt-4","title":"El Corazón de Eclipse ha sido robado","description":"El artefacto ha desaparecido de la Cámara de las Reliquias. Sólo alguien con acceso de Antiguo podría haber entrado. La traición viene de dentro.","timestamp":"2024-01-05T00:00:00Z","importance":10}]',
      '{"fase":"Crisis inicial","Rey Demonio estado":"Despertado, reuniendo fuerzas","Corazón de Eclipse":"ROBADO - ubicación desconocida","alianza_humana":"Negociando","clanes_vampiricos_leales":"3 de 5","clanes_vampiricos_silenciosos":"Clan Nocthar y Clan Velsh","Sorin_estado":"Investigando el robo","Elara_estado":"Presidiendo el Consejo, bajo presión"}',
      '[{"id":"tl-1","label":"El Antiguo Mundo","description":"Hace 5000 años: Primer vampiro creado. Los Cinco Clanes originales fundan el Dominio.","order":1},{"id":"tl-2","label":"La Gran Guerra Demoníaca","description":"Hace 1000 años: El Rey Demonio conquista un tercio del continente. La alianza de razas lo sella a costa de miles de vidas.","order":2},{"id":"tl-3","label":"Los Siglos de Paz Frágil","description":"1000 años de calma tensa. Los vampiros decaen en número. Los humanos olvidan el peligro. Los elfos advierten.","order":3},{"id":"tl-4","label":"El Presente","description":"Ahora: El sello se rompe. El Corazón es robado. La guerra se acerca.","order":4}]',
      '["No describir actos sexuales explícitos","Respetar la jerarquía de poder establecida en el lore","Los humanos con magia solar hacen daño físico a los vampiros","El Rey Demonio no aparece directamente hasta que la historia lo justifique"]',
      1,
      datetime('now'),
      datetime('now')
    )
  `);

  // Link the two seed characters to the seed story
  db.run(sql`
    INSERT OR IGNORE INTO story_characters (story_id, character_id, role, notes)
    VALUES
      ('story-cronicas-rey-demonio', 'char-elara-sangreverde', 'Protagonista / Señora del Consejo', 'Presidenta del Consejo de los Antiguos. Posee el conocimiento del Corazón de Eclipse pero no su ubicación actual.'),
      ('story-cronicas-rey-demonio', 'char-sorin-umbraveil', 'General / Investigador', 'Comandante militar del Dominio. Investiga el robo del Corazón. Tiene acceso a los archivos secretos del Clan Sangreverde.')
  `);

  // ─── Bootstrap admin user ─────────────────────────────────────────────────
  // Created once; password can be changed through the UI later.
  const adminHash = hashSync('admin', 10);
  db.run(sql`
    INSERT OR IGNORE INTO users (id, username, password_hash, display_name, role, is_active, created_at, updated_at)
    VALUES ('user-admin', 'admin', ${adminHash}, 'Admin', 'admin', 1, datetime('now'), datetime('now'))
  `);

  // ─── Migrate legacy data → admin ──────────────────────────────────────────
  // Any row without a user_id is assigned to the admin so nothing is lost.
  db.run(sql`UPDATE characters    SET user_id = 'user-admin' WHERE user_id IS NULL`);
  db.run(sql`UPDATE stories       SET user_id = 'user-admin' WHERE user_id IS NULL`);
  db.run(sql`UPDATE conversations SET user_id = 'user-admin' WHERE user_id IS NULL`);
}
