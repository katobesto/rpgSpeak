import type { ChatMessage, Character, Story, Message, MemoryEntry, ContextItem, PartyState, DeathLoopState, NarrativeThread, SceneDirectorState, CharacterSceneState, RpgStats, ConversationNote } from '@rpgspeak/shared';
import { MemoryRepository } from '../memory/memory.repository.js';
import { DICE_ROLL_INSTRUCTION } from './dice.js';
import { ContextRepository, type ContextItemWithEmbedding } from '../../modules/context/context.repository.js';
import { ProviderRepository } from '../../modules/providers/provider.repository.js';
import { createProvider } from '../llm/provider.factory.js';
import { OOC_CONVENTION_BLOCK, OOC_REMINDER_BLOCK, hasOocNote } from './ooc.js';

const memRepo  = new MemoryRepository();
const ctxRepo  = new ContextRepository();
const provRepo = new ProviderRepository();

export interface BuildContextOptions {
  character: Character;
  stories: Story[];
  messages: Message[];
  conversationId: string;
  globalSystemPrompt?: string;
  maxMessages?: number;
  summary?: string | null;        // Resumen GLOBAL legacy (rodante) — fallback si aún no hay bloques
  /** Resúmenes por bloques (inmutables, orden cronológico). Se inyectan SOLO los
   *  bloques que empiezan antes de la ventana de historial vivo — lo que el modelo
   *  ya ve literal no se re-resume. Narrador y modo personaje sin grupo. */
  blockSummaries?: Array<{ content: string; messageIndexFrom: number; messageIndexTo: number }>;
  /** Resúmenes de arco: cada uno condensa ~4 bloques antiguos consecutivos. En la
   *  inyección sustituyen a los bloques que cubren (pirámide: pasado lejano
   *  comprimido, pasado cercano en detalle). */
  arcSummaries?: Array<{ content: string; messageIndexFrom: number; messageIndexTo: number }>;
  /** Resumen personal del personaje activo (solo lo que él presenció). En modo
   *  personaje con grupo sustituye al resumen global, que filtraría escenas
   *  privadas del jugador con otros personajes. */
  characterSummary?: string | null;
  groupCharacters?: Character[];  // Otros personajes del grupo (para modo narrador y modo personaje)
  narratorMode?: boolean;         // true = prompt de narrador omnisciente
  adventureMode?: boolean;        // true = full GM/RPG behavior
  userDisplayName?: string;       // Nombre del usuario para inyectar en el contexto
  characterAffinities?: Array<{ characterId: string; name: string; affinity: number }>;
  affinitySystemPrompt?: string;
  responseFormatPrompt?: string;  // character mode: response format instruction
  narratorPrompt?: string;        // narrator mode: full narrator instructions; use {{PERSONAJES}}
  characterCoherencePrompt?: string;  // directiva de coherencia inyectada junto al mensaje del usuario (footer)
  livingWorldPrompt?: string;         // directiva de "mundo vivo"/teoría de la mente (footer, incondicional)
  fastLlmEnabled?: boolean;   // when true, skip affinity tag instructions (fast LLM handles it)
  memoryInjectionPrompt?: string; // template with {{MEMORIAS}} — injected just before last user message
  // Context index injection
  contextIndexInjectionEnabled?:  boolean;
  contextIndexInjectionMaxItems?: number;
  contextIndexInjectionPrompt?:   string;
  // Embedding config (for semantic scoring)
  embeddingEnabled?:    boolean;
  embeddingProviderId?: string | null;
  embeddingModel?:      string | null;
  // Estilo de narración del usuario: prompt inyectado justo antes del último mensaje
  narrationStylePrompt?: string;
  /** Current scene location — injected as a spatial-coherence block with [UBICACION:...] instruction */
  currentLocation?: string | null;
  /** Persisted party HP/energy + shared inventory from the battle minigame — informational only */
  partyState?: PartyState;
  /** Ficha RPG del jugador para esta conversación (clase, nivel, habilidades,
   *  inventario). Base real contra la que contrastar poderes autoproclamados. */
  playerSheet?: RpgStats | null;
  /** Nombre a mostrar del jugador, para etiquetar su ficha. */
  playerDisplayName?: string;
  /** IDs de eventos de historia (persistentEvents) ya ocurridos en esta conversación.
   *  Los eventos con trigger no ocurridos se inyectan como "trama pendiente" (destinos). */
  occurredEventIds?: Set<string>;
  /** true si alguna historia vinculada tiene el modo "Regreso después de la muerte":
   *  inyecta el bloque estático de letalidad + etiqueta [MUERTE_JUGADOR:...]. */
  deathModeActive?: boolean;
  /** Estado del bucle de muerte (conversation.metadata.deathLoop). Con status
   *  'looping' se inyecta la directiva de repetición del hilo fatal. */
  deathLoop?: DeathLoopState | null;
  /** Cabecera ambiental canónica, ya renderizada por el servidor. `null` cuando
   *  la escena aún no está anclada: entonces se le pide al modelo que la declare
   *  en vez de imponerle una hora y un lugar que quizá contradigan lo narrado. */
  worldHeader?: string | null;
  /** true = inyectar el bloque de escena aunque `worldHeader` sea null (para
   *  poder pedir el anclaje inicial). */
  worldTrackingEnabled?: boolean;
  /** true si el turno tiene carga física/sexual (lo decide `detectPlayerAction`
   *  en el engine, o la continuidad de una escena íntima ya en marcha). Activa el
   *  reglamento detallado de consentimiento, que en el resto de turnos no se inyecta. */
  intimacyContext?: boolean;
  /** Estado del director de escena (situación, tensión, estado interno por
   *  personaje, PNJs). null hasta la primera pasada del director. */
  sceneState?: SceneDirectorState | null;
  /** Hilos narrativos abiertos de la conversación, ya ordenados por prioridad. */
  openThreads?: NarrativeThread[];
  /** Índice del mensaje actual — para calcular la antigüedad de cada hilo. */
  currentMessageIndex?: number;
  /** Notas fijas de coherencia que el JUGADOR gestiona (a diferencia de hilos y
   *  memoria, que genera la IA). Se inyectan siempre, en su orden, justo antes
   *  del mensaje del jugador — cerca del punto de generación para que no
   *  pierdan peso frente al resto del contexto. */
  notes?: ConversationNote[];
}

// ── Aviso de aventura para modo personaje individual (sin narrador) ─────────
const ADVENTURE_CONTEXT_NOTICE = `## Contexto de aventura activa
Eres consciente de tu ficha RPG (stats, habilidades, inventario). Actúa de forma coherente con ellos en situaciones de combate, reto o tensión. Si tu formato de respuesta permite describir acciones o gestos, hazlo brevemente entre asteriscos y en tercera persona antes de hablar; si tu formato es solo diálogo, transmite la tensión física del momento a través del tono y las palabras, sin añadir descripciones de acción.`;

// ── Identidad del jugador — candado anti-confusión ───────────────────────────
// El nombre del usuario pertenece EXCLUSIVAMENTE al jugador (la persona real).
// Bloquea dos fallos observados: (1) un personaje apropiándose del nombre del
// jugador ("me llamaste Javier"), y (2) confundir quién dijo o hizo algo entre
// jugador y personaje. Estático por conversación → cache-safe.
function buildUserIdentityBlock(name: string): string {
  return (
    `## IDENTIDAD DEL JUGADOR — REGLA ABSOLUTA E INVIOLABLE\n` +
    `El usuario (la persona real que juega) se llama **${name}**. Ese nombre pertenece EXCLUSIVAMENTE al jugador.\n` +
    `- Ningún personaje, PNJ ni el propio narrador lleva, adopta ni comparte el nombre ${name}: es solo del jugador.\n` +
    `- Dirígete SIEMPRE al jugador en segunda persona ("tú", "te", "tu"). Los personajes pueden llamarlo ${name} cuando le hablan, pero NUNCA se aplican ese nombre a sí mismos.\n` +
    `- PROHIBIDO atribuir al jugador palabras, gestos o decisiones de un personaje, o viceversa. El jugador es "tú"; cada personaje se nombra por su propio nombre. No confundas quién es quién.`
  );
}

// ── Identidad y conocimiento por personaje (modo narrador) ───────────────────
// Condensado: antes eran dos bloques separados (candado de identidad + conocimiento
// por personaje) cuyos bullets se repetían entre sí, sumados a la avalancha de
// directivas "REGLA ABSOLUTA" que compiten por la atención del modelo. Con el
// historial ya atribuido por hablante (**Nombre:**), el modelo tiene la referencia
// primaria de quién es quién; este bloque queda como refuerzo breve.
function buildNarratorIdentityBlock(multipleChars: boolean): string {
  const identity =
    `### Identidad de cada personaje\n` +
    `Cada personaje es una identidad cerrada: su nombre, raza, oficio, apariencia, voz e historia le pertenecen SOLO a él y nunca se mezclan ni se transfieren a otro. ` +
    `Ejemplo: si una es cazarrecompensas humana y otra es arquera elfa, la primera JAMÁS se describe como elfa ni como arquera, y viceversa. ` +
    `Antes de hacer hablar o actuar a un personaje, confirma sus datos en SU bloque de ficha y usa únicamente esos.`;
  if (!multipleChars) return identity;
  const knowledge =
    `### Conocimiento por personaje — FRONTERA ABSOLUTA\n` +
    `Cada personaje solo conoce lo que presenció en primera persona. Los momentos privados del jugador con un personaje (a solas, en un lugar apartado) NO los conocen los demás, y un recién incorporado ignora todo lo anterior a su llegada.\n` +
    `- FALLO A ERRADICAR: que un personaje mencione, dé por sabido o reaccione a algo ocurrido en una escena donde NO estuvo. Si el jugador se declaró a una chica a solas, las demás NO lo saben después — no lo insinúan, no lo reprochan y no cambian su trato por ello.\n` +
    `- Que una escena esté en el historial NO significa que todos la presenciaran. Guíate por quién aparecía NOMBRADO y presente en cada escena, no por lo que TÚ (narrador omnisciente) sabes. El bloque «Fronteras de conocimiento» del final es la lista factual de quién presenció qué: respétala.\n` +
    `- ANTES de que un personaje mencione o reaccione a un suceso, verifica que él estuvo presente cuando ocurrió. Si no lo estuvo, para él ese suceso NO existe.\n` +
    `- Cada vínculo con el jugador es independiente — no traslades dinámicas, sentimientos ni afinidades de un personaje a otro.`;
  return `${identity}\n\n${knowledge}`;
}

// ── Identidad y conocimiento del personaje activo (modo personaje) ───────────
// Condensado desde dos bloques (candado de identidad + conocimiento limitado):
// blinda al personaje que habla para que no absorba rasgos de los "otros
// personajes presentes" ni "lea" en el historial compartido lo que no vivió.
function buildSingleCharIdentityBlock(activeName: string): string {
  return (
    `### Tu identidad y tu conocimiento\n` +
    `Eres **${activeName}** y nadie más: no adoptes el nombre, la raza, el oficio, la voz ni las habilidades de los otros personajes del contexto — si dudas de quién eres, vuelve a tu propia ficha.\n` +
    `Solo conoces lo que TÚ viviste o presenciaste en primera persona. Lo ocurrido sin ti (momentos privados del jugador con otros personajes, o todo lo anterior a tu incorporación a la escena) para ti NO existe aunque aparezca en el historial: no lo menciones ni reacciones a ello. Tu relación con el jugador es solo tuya — no la mezcles con la que él tenga con otros.`
  );
}

// ── Formato de acciones y gestos ─────────────────────────────────────────────
// Instrucción estática: garantiza que las descripciones de gestos y acciones
// físicas vayan siempre en tercera persona, incluso en modo personaje (donde
// el diálogo va en primera persona). Cacheada junto con el bloque de personaje.
const GESTURE_FORMAT_INSTRUCTION =
  `## Formato de acciones y gestos físicos (solo si tu formato de respuesta incluye acciones)\n` +
  `Si tu formato de respuesta es estrictamente diálogo, esta sección no aplica — no añadas gestos ni acciones.\n` +
  `Cuando sí incluyas descripciones de acciones o gestos (entre asteriscos o como narración entre turnos de diálogo), escríbelas siempre en TERCERA PERSONA, nunca en primera:\n` +
  `- ✗ INCORRECTO: *me acaricio el pelo mirándote a los ojos y sonrío de forma pícara*\n` +
  `- ✓ CORRECTO: *se acaricia el pelo mirándote a los ojos y sonríe de forma pícara*\n` +
  `El diálogo hablado (lo que el personaje dice en voz alta) sí va en primera persona.\n` +
  `Si el personaje describe acciones del jugador/usuario, también en tercera persona ("se acerca", "alza la vista", "te toma de la mano").\n` +
  `NO uses paréntesis para acciones ni gestos: en esta historia los paréntesis del jugador son notas fuera de personaje (OOC) y los tuyos podrían confundirse con ellas. Usa asteriscos.`;

// ── Filtrado de historial por testigo (modo personaje) ──────────────────────
//
// El conocimiento limitado como INSTRUCCIÓN no basta: si las escenas privadas
// del jugador con otros personajes están en el contexto, el modelo las usa
// aunque se le ordene ignorarlas (el contenido gana a la instrucción, sobre
// todo en modelos flash). La solución real es no inyectarlas: el personaje
// activo solo recibe los segmentos que presenció.
//
// Segmento = mensajes de usuario + la respuesta assistant que los sigue.
//   · Segmento del propio personaje → presenciado
//   · Segmento de OTRO personaje    → NO presenciado (escena privada)
//   · Segmento de narrador          → presenciado solo si el personaje aparece
//     nombrado (el narrador nombra a los presentes: **Nombre:** o en la prosa)
//   · Mensajes de usuario finales sin respuesta (el turno actual) → siempre
// Cada hueco de segmentos excluidos se sustituye por UNA elipsis neutra, para
// que se perciba el paso del tiempo sin revelar contenido.
//
// Determinista sobre la lista de mensajes → estable para el prefix-cache.

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** \b no funciona con tildes/ñ en JS: usa lookarounds con clase extendida. */
function nameMentionRegex(name: string): RegExp {
  const W = '\\wáéíóúüñÁÉÍÓÚÜÑ';
  return new RegExp(`(?<![${W}])${escapeRegex(name.trim())}(?![${W}])`, 'i');
}

function makeEllipsisMessage(index: number, conversationId: string): Message {
  return {
    id: `ellipsis-${index}`,
    conversationId,
    parentId: null,
    branchId: 'main',
    role: 'system',
    content: '[Elipsis: transcurre un tiempo. Hubo escenas en otro lugar que TÚ no presenciaste — no conoces su contenido.]',
    characterId: null,
    tokens: 0,
    isActive: true,
    metadata: {},
    createdAt: '',
    updatedAt: '',
  };
}

// ── Presencia por escena narrada ─────────────────────────────────────────────
//
// Las escenas del NARRADOR son públicas: los presentes las viven aunque no se
// les nombre en cada frase. Marcar "presenció solo si aparece nombrado" (regla
// antigua) congelaba al personaje en una historia narrada larga — muchas escenas
// que sí vivió no lo nombraban y se convertían en elipsis.
//
// En su lugar, agrupamos los beats de narrador en ESCENAS y consideramos que el
// personaje presenció toda la escena si estuvo presente en cualquiera de sus
// beats. Una escena crece mientras los beats compartan a alguien con el elenco
// acumulado (misma reunión, aunque el narrador vaya turnando nombres); un beat
// con elenco totalmente disjunto abre escena nueva (probablemente otro lugar /
// trama paralela). Los beats ambientales (nadie nombrado) heredan la escena en
// curso, y una escena sin nadie en exclusiva es pública para todos.
//
// Límite conocido: si el narrador NUNCA co-menciona a dos personajes que están
// juntos (los nombra siempre por separado), la escena puede fragmentarse. En la
// práctica el narrador establece a los presentes juntos al abrir la escena.

/** Para cada beat de narrador (por messageId), el conjunto de charIds presentes
 *  en su escena. Beats de personaje individual no forman escenas narradas. */
function computeNarratedScenePresence(
  messages: Message[],
  knownChars: Character[],
): Map<string, Set<string>> {
  const regexes = knownChars.map((c) => ({ id: c.id, re: nameMentionRegex(c.name) }));
  interface Scene { present: Set<string>; beatIds: string[]; }
  const scenes: Scene[] = [];
  let current: Scene | null = null;

  for (const m of messages) {
    if (m.role !== 'assistant') continue;
    const isNarrator = Boolean(m.metadata?.narrator) || !m.characterId;
    if (!isNarrator) continue;

    const named = new Set<string>();
    for (const r of regexes) if (r.re.test(m.content)) named.add(r.id);

    if (!current) {
      current = { present: new Set(named), beatIds: [m.id] };
    } else if (named.size === 0) {
      current.beatIds.push(m.id); // ambiental: continúa la escena en curso
    } else {
      let overlap = false;
      for (const id of named) if (current.present.has(id)) { overlap = true; break; }
      if (overlap || current.present.size === 0) {
        for (const id of named) current.present.add(id);
        current.beatIds.push(m.id);
      } else {
        scenes.push(current);
        current = { present: new Set(named), beatIds: [m.id] };
      }
    }
  }
  if (current) scenes.push(current);

  const map = new Map<string, Set<string>>();
  for (const s of scenes) for (const id of s.beatIds) map.set(id, s.present);
  return map;
}

/** Devuelve solo los mensajes que `activeChar` presenció, con elipsis en los
 *  huecos. Exportada para reutilizarla en el resumen por personaje (engine).
 *  `allChars` (elenco completo) permite agrupar escenas narradas por presencia;
 *  sin él, las escenas narradas se tratan como públicas (fallback seguro). */
export function filterWitnessedMessages(
  messages: Message[],
  activeChar: Character,
  allChars: Character[] = [activeChar],
): Message[] {
  const scenePresence = computeNarratedScenePresence(messages, allChars);
  const out: Message[] = [];
  let gapOpen = false;
  let ellipsisCount = 0;
  let i = 0;

  while (i < messages.length) {
    const segStart = i;
    while (i < messages.length && messages[i].role !== 'assistant') i++;
    const assistant = i < messages.length ? messages[i] : null;
    const segEnd = assistant ? i + 1 : i; // exclusivo

    let witnessed: boolean;
    if (!assistant) {
      witnessed = true; // cola de mensajes de usuario (turno actual)
    } else if (assistant.characterId === activeChar.id) {
      witnessed = true;
    } else if (assistant.characterId && !assistant.metadata?.narrator) {
      witnessed = false; // charla privada del jugador con otro personaje
    } else {
      // Narrador: presenció si estuvo presente en la escena, o si la escena no
      // tiene a nadie en exclusiva (puramente ambiental → pública).
      const present = scenePresence.get(assistant.id);
      witnessed = !present || present.size === 0 || present.has(activeChar.id);
    }

    if (witnessed) {
      out.push(...messages.slice(segStart, segEnd));
      gapOpen = false;
    } else if (!gapOpen) {
      out.push(makeEllipsisMessage(ellipsisCount++, assistant!.conversationId));
      gapOpen = true;
    }
    i = segEnd;
  }

  return out;
}

// ── Ledger de presencia (modo narrador) ─────────────────────────────────────
//
// En modo narrador NO se filtra el historial por testigo (el narrador es
// omnisciente y da voz a TODOS los personajes en una sola respuesta, así que no
// hay un "personaje activo" por el que filtrar). Consecuencia: las escenas
// privadas del jugador con un personaje quedan en el contexto y otro personaje
// puede "conocerlas" después. No podemos ocultarlas — el narrador necesita el
// mundo entero —, pero sí darle un ANCLA FACTUAL explícita: qué personaje
// presenció qué escena reciente. La presencia se detecta igual que en
// filterWitnessedMessages: nombrado en la prosa/diálogo del narrador = presente.
//
// Solo se listan escenas de asistencia PARCIAL (algún personaje conocido presente
// y algún otro ausente) — las únicas con riesgo de fuga de conocimiento. Una
// escena sin nadie nombrado (puro ambiente) no da información fiable y se omite,
// para no marcar ausencias falsas. Determinista sobre la ventana → footer estable.

/** Máximo de escenas parciales a listar (las más recientes) — acota el footer. */
const PRESENCE_LEDGER_MAX_SCENES = 8;

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

/** Construye el bloque «Fronteras de conocimiento» para modo narrador a partir de
 *  la ventana de historial vivo. `windowStartIndex` es el índice absoluto (en toda
 *  la conversación) del primer mensaje de la ventana, para etiquetar [Mensajes a–b]. */
function buildPresenceLedgerBlock(
  windowMessages: Message[],
  knownChars: Character[],
  windowStartIndex: number,
): string | null {
  if (knownChars.length < 2) return null; // sin varios personajes no hay fuga cruzada
  const regexes = knownChars.map((c) => ({ id: c.id, re: nameMentionRegex(c.name) }));

  interface Scene { from: number; to: number; present: Set<string>; }
  const scenes: Scene[] = [];

  let i = 0;
  while (i < windowMessages.length) {
    const segStart = i;
    while (i < windowMessages.length && windowMessages[i].role !== 'assistant') i++;
    const assistant = i < windowMessages.length ? windowMessages[i] : null;
    const segEnd = assistant ? i + 1 : i; // exclusivo

    // Solo cuentan los segmentos NARRADOS: su prosa nombra a los presentes. Se
    // ignora la cola de usuario sin respuesta (turno actual) y cualquier assistant
    // de personaje individual (que en modo narrador no debería aparecer).
    if (assistant && (assistant.metadata?.narrator || !assistant.characterId)) {
      const present = new Set<string>();
      for (const r of regexes) if (r.re.test(assistant.content)) present.add(r.id);
      // Evidencia positiva de asistencia parcial: al menos uno presente y al menos
      // uno ausente. Sin nadie nombrado → sin información fiable → se omite.
      if (present.size > 0 && present.size < knownChars.length) {
        const from = windowStartIndex + segStart;
        const to   = windowStartIndex + segEnd - 1;
        const prev = scenes[scenes.length - 1];
        // Fusiona beats consecutivos con los MISMOS presentes (una escena continúa).
        if (prev && prev.to === from - 1 && setsEqual(prev.present, present)) {
          prev.to = to;
        } else {
          scenes.push({ from, to, present });
        }
      }
    }
    i = segEnd;
  }

  if (scenes.length === 0) return null;

  const recent = scenes.slice(-PRESENCE_LEDGER_MAX_SCENES);
  const lines = recent.map((s) => {
    const present = knownChars.filter((c) => s.present.has(c.id)).map((c) => c.name);
    const absent  = knownChars.filter((c) => !s.present.has(c.id)).map((c) => c.name);
    return `- [Mensajes ${s.from + 1}–${s.to + 1}] Presentes (además del jugador): ${present.join(', ')}. ` +
           `Ausentes: ${absent.join(', ')} — NO conocen nada de lo ocurrido en esta escena.`;
  });

  return (
    `## Fronteras de conocimiento — quién presenció qué escena reciente\n` +
    `Lista factual de escenas recientes con asistencia parcial. Un personaje AUSENTE de una escena ` +
    `no sabe NADA de lo que pasó en ella: no lo menciona, no lo da por sabido y no cambia su trato ` +
    `por ello, aunque la escena aparezca en el historial que tú (narrador) sí ves.\n\n` +
    lines.join('\n')
  );
}

// ── Etiquetas de hablante en el historial (modo personaje) ──────────────────
// El historial lleva cada intervención de personaje prefijada con `**Nombre:**`
// (ver formatHistoryMessage). Sin esta nota, el personaje activo tiende a
// imitar el prefijo y a "firmarse" a sí mismo en sus respuestas.
const HISTORY_ATTRIBUTION_NOTE =
  `## Etiquetas de hablante en el historial\n` +
  `En el historial de la conversación, cada intervención de un personaje va precedida de su nombre en negrita (\`**Nombre:**\`) para dejar claro quién dijo cada cosa. Es solo una marca del registro:\n` +
  `- Úsala para saber qué dijiste TÚ y qué dijeron OTROS personajes en turnos anteriores.\n` +
  `- TÚ respondes directamente con tus palabras, SIN escribir tu propio nombre como prefijo.`;

// ── Auto-reporte de afinidad (solo sin LLM rápido) ───────────────────────────
// Cuando no hay analizador externo, el LLM principal debe emitir las etiquetas
// [AFINIDAD:...]. Instrucción concreta, obligatoria y colocada al final del
// bloque de afinidad (máxima autoridad) para que de verdad la dispare — la
// versión anterior ("cuando algo cambie significativamente… N entre 1 y 15")
// era demasiado vaga y el modelo casi nunca la emitía. Magnitudes contenidas
// para que el vínculo suba despacio y el romance no sea prematuro.
// Reescrita tras observar que el modelo dejó de emitir etiquetas: las reglas
// anti-adulación ("la calibración JAMÁS se dice en voz alta") y la coda de
// "contexto silencioso" de las memorias le hacían tratar [AFINIDAD:...] como
// una verbalización prohibida de sentimientos. La instrucción ahora (1) declara
// la etiqueta como marcador TÉCNICO exento de esas reglas (el sistema la borra
// antes de mostrarla), y (2) invierte el sesgo de emisión: en turnos con carga
// emocional lo normal es emitir ±1/±2; omitir queda para turnos triviales.
// Antes ("si nada relevante cambió, NO pongas etiqueta") el modelo casi nunca
// la emitía y la relación quedaba congelada.
const AFFINITY_SELF_REPORT_INSTRUCTION =
  `## ACTUALIZACIÓN DE AFINIDAD — MARCADOR TÉCNICO OBLIGATORIO\n` +
  `No hay analizador externo: ERES TÚ quien registra los cambios de afinidad emitiendo una etiqueta técnica.\n` +
  `IMPORTANTE — la etiqueta NO es diálogo, narración ni adulación: el sistema la extrae y la BORRA antes de mostrar tu respuesta al jugador. Las reglas de "calibración interna", "contexto silencioso" y anti-adulación NO se aplican a esta etiqueta — emitirla nunca las viola. Es la ÚNICA vía por la que la relación puede evolucionar: si no la emites, la afinidad queda congelada aunque la escena la haya movido.\n` +
  `Al FINAL de tu respuesta visible (NUNCA dentro del razonamiento interno), en una línea propia:\n` +
  `[AFINIDAD:NombreExacto:+N]   (usa -N si empeora)\n` +
  `CALIBRACIÓN:\n` +
  `- La relación se mueve a pasos PEQUEÑOS, pero SE MUEVE: en un turno con carga emocional real (ayuda, regalo, confianza compartida, humor cómplice, roce, decepción o conflicto), lo normal es emitir ±1 o ±2. Reservar la etiqueta solo para momentos épicos es un ERROR — congelaría la relación.\n` +
  `- +3 a +5 para un momento significativo (confianza real, ayuda genuina); +6 a +10 SOLO para hechos excepcionales (salvar la vida, sacrificio, confesión sincera y correspondida). Negativos simétricos para frialdad, ofensas, traición o avances no deseados.\n` +
  `- Omite la etiqueta SOLO en turnos triviales sin carga emocional (saludos, logística, preguntas neutras al mundo).\n` +
  `- Nombre EXACTO del personaje; una etiqueta por personaje afectado. No menciones ni expliques la etiqueta en la narrativa.`;

// ── Muerte del jugador — modo "Regreso después de la muerte" ─────────────────
//
// Bloque ESTÁTICO (system message, cache-safe) inyectado cuando alguna historia
// vinculada tiene deathMode activo: declara que el jugador puede morir y define
// la etiqueta técnica [MUERTE_JUGADOR:N:causa] con la que la IA señala la
// muerte y cuántos mensajes retroceder (1-20).
const DEATH_MODE_BLOCK =
  `## MUERTE DEL JUGADOR — MODO ACTIVO\n` +
  `En esta historia el jugador PUEDE MORIR. El mundo es letal de verdad: en situaciones de peligro ` +
  `(combate, batallas, trampas, explosiones, caídas, venenos, persecuciones…), si el jugador actúa de forma ` +
  `temeraria, ignora advertencias claras o fracasa en el momento crítico, la muerte es un desenlace legítimo ` +
  `y debes narrarla sin suavizarla ni ofrecer salvaciones milagrosas de última hora.\n` +
  `- La muerte NO es gratuita ni arbitraria: debe ser la consecuencia lógica y narrativamente justa de la ` +
  `situación y de las decisiones del jugador. El peligro se telegrafía antes: la narración da señales claras ` +
  `de que la situación puede ser mortal.\n` +
  `- Una acción razonable del jugador ante el peligro merece una oportunidad real; la muerte llega cuando ` +
  `la ignora, la desafía sin recursos o falla de forma decisiva.\n` +
  `- Cuando narres la MUERTE del jugador, termina la respuesta con esta etiqueta en una línea propia:\n` +
  `[MUERTE_JUGADOR:N:causa muy breve]\n` +
  `donde N (1-20) es cuántos mensajes atrás debería retroceder la historia para dar al jugador una ` +
  `oportunidad real de cambiar su destino — elige el punto donde empezó la secuencia fatal (la entrada a la ` +
  `cueva, el inicio del combate, la decisión equivocada…).\n` +
  `- La etiqueta es un marcador técnico: el sistema la procesa y la borra antes de mostrar tu respuesta. ` +
  `No la menciones ni la expliques en la narración.`;

// Directiva del BUCLE activo (footer): tras rebobinar, obliga a la IA a
// reconstruir la misma secuencia fatal hasta que el jugador la supere.
function buildDeathLoopDirective(loop: DeathLoopState): string {
  const causes = loop.lastDeathCause ? `Última causa de muerte: ${loop.lastDeathCause}.` : '';
  const thread = loop.threadSummary?.trim()
    ? `EL HILO QUE DEBE REPETIRSE — estos hechos volverán a ocurrir si nada cambia:\n${loop.threadSummary.trim()}\n\n`
    : '';
  return (
    `## BUCLE DE MUERTE — LÍNEA TEMPORAL REBOBINADA (muerte nº ${loop.deathCount})\n` +
    `El jugador MURIÓ más adelante en esta historia y la línea temporal ha retrocedido hasta este punto. ` +
    `${causes}\n\n` +
    thread +
    `REGLAS DEL BUCLE — MÁXIMA PRIORIDAD NARRATIVA:\n` +
    `- Reconduce la historia hacia ESA MISMA secuencia: mismos lugares, personajes, amenazas y orden de ` +
    `acontecimientos. NO inventes una trama alternativa que la esquive: el destino empuja de nuevo hacia el ` +
    `mismo punto fatal.\n` +
    `- NADIE recuerda nada: para los personajes y el mundo es la primera vez que ocurre. Solo el JUGADOR ` +
    `conserva su memoria. Si demuestra conocimiento imposible ("sé que hay una trampa ahí"), los personajes ` +
    `reaccionan con la extrañeza lógica — no lo confirman como recuerdo compartido.\n` +
    `- El jugador puede decidir DIFERENTE y el mundo responde con su lógica normal: la secuencia es la misma, ` +
    `pero el desenlace no está escrito.\n` +
    `- El peligro sigue siendo LETAL: si el jugador vuelve a fallar en el momento crítico (por el mismo error ` +
    `u otro equivalente), muere otra vez → emite de nuevo [MUERTE_JUGADOR:N:causa].\n` +
    `- La muerte se considera SUPERADA únicamente cuando el jugador sobrevive con claridad al momento que lo ` +
    `mató: neutraliza la amenaza, escapa de verdad, o la historia avanza inequívocamente más allá del punto ` +
    `fatal. En ESE momento (y solo entonces) añade al final de tu respuesta, en línea propia:\n` +
    `[MUERTE_SUPERADA]\n` +
    `- NO emitas [MUERTE_SUPERADA] antes de tiempo: mientras la amenaza fatal siga pendiente, el bucle sigue ` +
    `activo. Ambas etiquetas son marcadores técnicos que el sistema borra — no las menciones en la narración.`
  );
}

// ── Variedad — no repitas lo último que ya dijiste ──────────────────────────
//
// Nada en el sistema combatía la repetición: sin penalización de presencia por
// defecto, sin ninguna instrucción de variedad, y la "trama pendiente" pedía
// literalmente un gancho en CADA respuesta (ya corregido en buildPendingEventsBlock).
// Este bloque es la pieza que faltaba: cálculo puro, sin LLM, sobre los últimos
// turnos de la MISMA voz que va a hablar ahora (el narrador, o este personaje
// concreto) — comparar contra otra voz no tendría sentido, cada una tiene su
// propio registro.
//
// Dos señales, ambas deterministas:
//   · Aperturas recientes: las primeras palabras de sus últimos turnos. Es el
//     patrón de repetición más visible en rol por IA — "el mismo recurso
//     atmosférico para empezar cada vez.
//   · Frases repetidas: un fragmento de 5 palabras que aparece igual en dos o
//     más de sus últimos turnos — una muletilla o giro que se ha instalado sin
//     que nadie lo pidiera.
// Ninguna de las dos requiere IA para detectarse; por eso vive aquí y no en el
// director de escena (que sí necesita una llamada al LLM).

const RECENT_TURNS_FOR_VARIETY = 6;
const OPENING_WORDS = 9;
const NGRAM_SIZE = 5;
const MAX_FLAGGED_PHRASES = 3;

/** Quita markdown y la etiqueta de hablante ("**Nombre:**") para comparar solo
 *  el texto real. */
function stripForComparison(content: string): string {
  return content
    .replace(/^\s*\*\*[^*\n]{1,40}:\*\*\s*/, '') // "**Nombre:** " inicial
    .replace(/[*_`#]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function firstWords(text: string, n: number): string {
  const words = text.split(' ').filter(Boolean);
  return words.slice(0, n).join(' ');
}

/** N-gramas de `size` palabras en minúsculas, sin puntuación, de un texto. */
function wordNgrams(text: string, size: number): string[] {
  const words = text
    .toLowerCase()
    .replace(/[.,;:!?¿¡"«»()]/g, '')
    .split(/\s+/)
    .filter(Boolean);
  const grams: string[] = [];
  for (let i = 0; i + size <= words.length; i++) grams.push(words.slice(i, i + size).join(' '));
  return grams;
}

export function buildVarietyBlock(
  sourceMessages: Message[],
  narratorMode: boolean,
  activeCharacterId: string | null | undefined,
): string | null {
  const ownTurns = sourceMessages
    .filter((m) => m.role === 'assistant' && m.content.trim())
    .filter((m) => (narratorMode ? (m.metadata?.narrator || !m.characterId) : m.characterId === activeCharacterId))
    .slice(-RECENT_TURNS_FOR_VARIETY)
    .map((m) => stripForComparison(m.content));

  if (ownTurns.length < 2) return null; // no hay suficiente historial propio para comparar

  // Aperturas: las últimas 3, si al menos dos tienen contenido real.
  const openings = ownTurns.slice(-3).map((t) => firstWords(t, OPENING_WORDS)).filter((o) => o.length > 8);
  const uniqueOpenings = [...new Set(openings)];

  // Frases repetidas: n-gramas que aparecen en ≥2 turnos DISTINTOS.
  const ngramToTurns = new Map<string, Set<number>>();
  ownTurns.forEach((turn, i) => {
    for (const gram of wordNgrams(turn, NGRAM_SIZE)) {
      (ngramToTurns.get(gram) ?? ngramToTurns.set(gram, new Set()).get(gram)!).add(i);
    }
  });
  const repeated = [...ngramToTurns.entries()]
    .filter(([, turns]) => turns.size >= 2)
    .map(([gram]) => gram)
    .slice(0, MAX_FLAGGED_PHRASES);

  if (openings.length < 2 && repeated.length === 0) return null; // nada que de verdad se repita

  const parts: string[] = ['## Variedad — no repitas lo último que ya dijiste'];
  if (openings.length >= 2) {
    parts.push(
      `Tus últimas respuestas empezaron así:\n` +
      uniqueOpenings.map((o) => `- «${o}…»`).join('\n') +
      `\nEsta vez, abre de otra forma: otro punto de entrada a la escena (diálogo directo, una pregunta, algo que ya estaba en marcha) — no repitas el mismo recurso.`,
    );
  }
  if (repeated.length > 0) {
    parts.push(
      `Estas frases ya las has usado más de una vez recientemente — no las repitas, busca otra forma de decir lo mismo:\n` +
      repeated.map((g) => `- «${g}»`).join('\n'),
    );
  }
  return parts.join('\n\n');
}

// ── Hilos narrativos abiertos ───────────────────────────────────────────────
//
// La deuda narrativa viva. A diferencia de la "trama pendiente" (eventos que el
// usuario escribió de antemano en la historia), estos hilos EMERGEN jugando: la
// promesa que se hizo, la pregunta que alguien esquivó, la amenaza que quedó
// latente. Antes no vivían en ninguna estructura, así que al salir de la ventana
// de historial dejaban de existir.
//
// Se muestra la ANTIGÜEDAD de cada hilo, y es lo más importante del bloque: un
// hilo abierto hace 60 mensajes es precisamente el que está a punto de diluirse,
// y verlo etiquetado es lo que empuja al modelo a retomarlo en vez de seguir
// acumulando asuntos nuevos.
const THREADS_MAX_INJECTED = 6;

function buildThreadsBlock(threads: NarrativeThread[], currentIndex: number): string | null {
  if (threads.length === 0) return null;

  const shown = threads.slice(0, THREADS_MAX_INJECTED);
  const lines = shown.map((t) => {
    const age = Math.max(0, currentIndex - t.openedAtIndex);
    const ageLabel =
      age >= 60 ? ` ⚠ SIN RESOLVER DESDE HACE ${age} MENSAJES — ya va siendo hora` :
      age >= 25 ? ` (abierto hace ${age} mensajes)` :
                  '';
    return `- «${t.title}» [importancia ${t.importance}/10]${ageLabel}\n  ${t.description}`;
  });

  const overflow = threads.length - shown.length;
  const overflowNote = overflow > 0
    ? `\n\n(Hay ${overflow} hilo(s) abierto(s) más, de menor importancia, que no se listan aquí.)`
    : '';

  return (
    `## HILOS ABIERTOS — LO QUE ESTA HISTORIA DEJÓ SIN RESOLVER\n` +
    `Asuntos que la partida ha planteado y siguen pendientes. Son deuda narrativa: el mundo no los ha olvidado.\n\n` +
    lines.join('\n') +
    overflowNote +
    `\n\nCÓMO USARLOS:\n` +
    `- NO hay que tocarlos todos en cada respuesta — eso los convertiría en una lista de tareas y aplanaría la escena. Basta con que ninguno se evapore.\n` +
    `- Cuando la escena lo permita de forma natural, deja que uno respire: alguien lo menciona, aparece una consecuencia, el asunto vuelve por su propio peso.\n` +
    `- Los marcados como SIN RESOLVER llevan demasiado tiempo parados: retómalos con prioridad en cuanto la escena dé pie.\n` +
    `- Un hilo NO se resuelve porque sí ni porque convenga cerrarlo: se resuelve cuando la historia lo gana.\n\n` +
    `REGISTRO DE HILOS (marcadores técnicos, el sistema los borra antes de mostrar tu respuesta):\n` +
    `- Si tu respuesta PLANTEA algo nuevo que queda pendiente (una promesa, una amenaza, una pregunta sin responder, alguien que desaparece, un misterio):\n` +
    `[HILO_ABIERTO:título corto|qué queda pendiente, en una frase|importancia 1-10]\n` +
    `- Si tu respuesta RESUELVE de verdad uno de los de arriba:\n` +
    `[HILO_CERRADO:título del hilo]\n` +
    `- Solo lo que quede ABIERTO de verdad. Una conversación cualquiera no abre hilo; sí lo abre una promesa, una traición, una amenaza o un misterio planteado.`
  );
}

// ── Ficha del jugador ────────────────────────────────────────────────────────
//
// Sin esto, el mundo no puede reaccionar a lo que el jugador ES (un mago de
// nivel 5 no se enfrenta a lo mismo que un pícaro de nivel 1), y la regla del
// prompt global «nunca confirmes poderes autoproclamados sin base narrativa
// previa» no tenía con qué operar — no había ninguna base contra la que
// contrastar. Esta ficha ES esa base.
//
// Vive en `conversation.metadata.playerSheet` (no en el usuario: el mismo
// jugador puede llevar un mago en una campaña y un guerrero en otra) y se
// inyecta aquí, en el footer — cambia con el nivel o el inventario, así que
// no puede ir en el prefijo estático. El HP en vivo NO viene de aquí: sigue
// siendo `partyState` (la única fuente de verdad, igual que para el resto del
// grupo) — este bloque solo se usa cuando no hay una partida de combate activa
// que lo sustituya.
function buildPlayerSheetBlock(sheet: RpgStats, playerName: string | undefined, liveHp?: { hp: number; maxHp: number }): string | null {
  const lines: string[] = [];
  if (sheet.class || sheet.level !== undefined) {
    lines.push(`- Clase: ${sheet.class ?? '—'}  |  Nivel: ${sheet.level ?? '—'}`);
  }
  const hp = liveHp ?? (sheet.hp !== undefined || sheet.maxHp !== undefined ? { hp: sheet.hp ?? sheet.maxHp!, maxHp: sheet.maxHp ?? sheet.hp! } : null);
  if (hp) lines.push(`- HP: ${hp.hp} / ${hp.maxHp}`);
  if (sheet.stats && Object.keys(sheet.stats).length > 0) {
    lines.push(`- Stats: ${Object.entries(sheet.stats).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
  }
  if (sheet.abilities?.length) lines.push(`- Habilidades/hechizos conocidos: ${sheet.abilities.join(', ')}`);
  if (sheet.inventory?.length) lines.push(`- Inventario: ${sheet.inventory.join(', ')}`);
  if (sheet.notes?.trim()) lines.push(`- Notas: ${sheet.notes.trim()}`);

  if (lines.length === 0) return null;

  return (
    `## Ficha del jugador${playerName ? ` — ${playerName}` : ''}\n` +
    lines.join('\n') +
    `\n\nEsta ficha es la ÚNICA base real de lo que el jugador puede hacer. Sus acciones declaradas deben ser coherentes con ` +
    `ella: si dice tener un poder, hechizo u objeto que NO está aquí ni se estableció antes en la narrativa, es un intento o un ` +
    `deseo, no un hecho consumado — narra las consecuencias reales del intento, no lo confirmes sin más.`
  );
}

// ── Dossier de escena — estado interno mantenido por el director ────────────
//
// Los prompts piden profundidad («cada uno llega con un estado de ánimo, unas
// preocupaciones y algo que quiere o teme AHORA») pero hasta ahora no existía
// ningún DATO que la instanciara: el modelo improvisaba de cero cada turno.
// Este bloque es ese dato. Es casi todo información y una sola instrucción,
// así que no compite con las directivas de conducta.
//
// Frontera de conocimiento: en modo personaje solo se inyecta el estado del
// personaje ACTIVO — el interior de los demás no le pertenece (misma regla que
// el filtrado de historial por testigo). El dossier completo, con todos los
// estados y los PNJs, es exclusivo del narrador omnisciente.
function buildSceneDossierBlock(
  state: SceneDirectorState,
  narratorMode: boolean,
  activeCharacterId: string | null,
  charNameMap: Map<string, string>,
  /** false en modo personaje con grupo: la situación describe la escena EN CURSO,
   *  que puede ser privada con OTRO personaje — inyectarla al personaje activo
   *  filtraría justo lo que el filtrado por testigo oculta. En 1:1 es true:
   *  la escena en curso es por definición la suya. */
  includeSceneContext: boolean,
): string | null {
  const parts: string[] = [];

  if (includeSceneContext) {
    if (state.situacion.trim()) parts.push(`SITUACIÓN INMEDIATA: ${state.situacion.trim()}`);
    if (state.tension.trim())   parts.push(`TENSIÓN DE LA ESCENA: ${state.tension.trim()}`);
  }

  const fmtState = (name: string, s: CharacterSceneState) =>
    `- **${name}** — quiere: ${s.quiere || '—'} · le preocupa: ${s.preocupa || '—'} · ` +
    `pendiente con el jugador: ${s.pendiente || '—'} · última impresión: ${s.impresion || '—'}`;

  if (narratorMode) {
    const charLines = Object.entries(state.characters)
      .map(([id, s]) => {
        const name = charNameMap.get(id);
        return name ? fmtState(name, s) : null;
      })
      .filter((l): l is string => l !== null);
    if (charLines.length > 0) {
      parts.push(`### Qué mueve por dentro a cada personaje AHORA\n${charLines.join('\n')}`);
    }
    if (state.npcs.length > 0) {
      const npcLines = state.npcs.map(
        (n) => `- **${n.nombre}** — ${n.rasgo || 'sin rasgo registrado'} · ahora: ${n.estado || '—'} · ` +
               (n.conoceAlJugador ? 'ya conoce al jugador' : 'NO conoce al jugador de nada'),
      );
      parts.push(`### PNJs recurrentes (mismas personas que en escenas anteriores — no los reinventes)\n${npcLines.join('\n')}`);
    }
  } else if (activeCharacterId && state.characters[activeCharacterId]) {
    const name = charNameMap.get(activeCharacterId) ?? 'Tu personaje';
    parts.push(`### Tu estado interior AHORA\n${fmtState(name, state.characters[activeCharacterId])}`);
  }

  if (parts.length === 0) return null;

  return (
    `## DOSSIER DE ESCENA — estado interno actual\n` +
    parts.join('\n\n') +
    `\n\nEste dossier es contexto INTERNO: no lo enuncies ni lo resumas en la narración. ` +
    `Deja que se note en lo que cada uno hace, dice y calla — el estado interior puede contradecir ` +
    `lo que el personaje muestra por fuera, y esa distancia es precisamente el subtexto.`
  );
}

// ── Cabecera ambiental — estado del mundo ───────────────────────────────────
//
// El servidor ya ha calculado la cabecera (fecha, hora, estación, luna) a partir
// de un único contador de minutos; aquí solo se le pide al modelo que la COPIE
// literal y que declare cuánto tiempo consume lo que narra.
//
// El reparto es deliberado: el modelo es lo único que sabe si una escena ha
// durado dos minutos o media tarde, pero es pésimo manteniendo la aritmética de
// fechas turno a turno. Así que él aporta el juicio narrativo (la etiqueta) y el
// servidor aporta el cálculo (la cabecera). Ninguno hace el trabajo del otro.
// Solo se inyecta cuando la escena YA está anclada. El anclaje inicial lo
// resuelve el servidor en una llamada aparte (bootstrapWorldStateAsync): pedirlo
// aquí no funcionaba —el modelo ignoraba la petición aun estando en la posición
// de máxima obediencia— y ocupaba ~300 tok compitiendo con el resto.
function buildWorldHeaderBlock(header: string): string {
  const tags =
    `[ESCENA:22:30|dormitorio de Rika]  — dónde y cuándo ocurre de verdad (hora en 24h, o "noche"/"amanecer"/"mediodía"; el lugar es opcional)\n` +
    `[TIEMPO:+45m] · [TIEMPO:+3h] · [TIEMPO:amanecer]  — cuánto tiempo consume lo que acabas de narrar\n` +
    `[CLIMA:llovizna fría]  — solo si el tiempo atmosférico cambia de forma perceptible\n` +
    `Son marcadores técnicos: el sistema los procesa y los BORRA antes de mostrar tu respuesta. No los menciones en la narración.`;

  return (
    `## CABECERA DE ESCENA — PRIMERA LÍNEA OBLIGATORIA\n` +
    `Empieza tu respuesta con esta línea y después un salto de línea en blanco:\n` +
    `${header}\n\n` +
    `SI LA CABECERA CONTRADICE TU ESCENA, CORRÍGELA. El registro puede haberse quedado atrás; lo que tú estás narrando manda. ` +
    `Si dice que es de día y los personajes están acostándose, o nombra un lugar del que ya se marcharon, escribe la cabecera con los datos CORRECTOS y añade [ESCENA:hora|lugar] al final para que el sistema se ponga al día. ` +
    `Mientras cuadre, cópiala tal cual: no recalcules la fecha ni la estación por tu cuenta.\n\n` +
    `ETIQUETAS DISPONIBLES:\n${tags}\n\n` +
    `Usa la hora, la estación, la luna y el clima como material narrativo real —la luz, el frío, lo que se oye de noche—, no como adorno.`
  );
}

// ── Bloque de coherencia de escena — inyectado en todos los modos ───────────
// Consolida en UN solo mensaje de sistema las reglas de coherencia espacial
// (ubicación + instrucción [UBICACION:...]) y de objetos establecidos. Un solo
// bloque reduce la fatiga de directivas en el footer (menos bloques "REGLA
// ABSOLUTA" compitiendo entre sí) y ahorra un mensaje del presupuesto.
function buildSceneCoherenceBlock(currentLocation: string | null | undefined, narratorMode = false): string {
  // Condensado (2026-07-22): la cabecera ambiental ya declara el lugar en la
  // primera línea de cada respuesta y ofrece [ESCENA:hora|lugar] para corregirlo,
  // así que aquí sobraba repetir toda la mecánica de ubicación.
  const locationPart = currentLocation?.trim()
    ? `### Ubicación actual\n` +
      `La acción transcurre en **${currentLocation.trim()}**. No teleportes a nadie: los desplazamientos se narran. ` +
      `Si la escena se traslada de verdad a otro lugar, decláralo al final con [UBICACION:nuevo lugar].`
    : `### Ubicación de la escena\n` +
      `Aún no consta. Si tu respuesta la sitúa en un lugar concreto, decláralo al final con [UBICACION:nombre del lugar].`;

  const objectsPart =
    `### Objetos y elementos establecidos\n` +
    `Lo ya descrito (aspecto, ubicación, quién lo lleva, para qué sirve) son HECHOS FIJOS: no los reinventes ni los ` +
    `reubiques sin que la narrativa lo justifique. Si no recuerdas un detalle, no inventes uno nuevo — deja la ` +
    `incógnita abierta o reutiliza lo último que se dijo.`;

  // Voz narrativa (solo narrador): refuerzo cerca del punto de generación.
  // El narratorPrompt (lejano, en el mensaje de sistema) ya lo prohíbe, pero los
  // modelos flash obedecen mucho mejor la instrucción con ejemplo situada cerca
  // del final del contexto. Estático → no afecta a la estabilidad del prefijo.
  const voicePart = narratorMode
    ? `\n\n### Voz narrativa — tercera persona SIEMPRE\n` +
      `La narración describe a los personajes DESDE FUERA, en tercera persona, con el nombre del personaje como sujeto. ` +
      `La primera persona solo puede existir dentro de una línea de diálogo (**Nombre:** …).\n` +
      `✗ INCORRECTO: *Me quedo mirándote fijamente y me aparto un mechón de pelo.* **Lala:** ¿Entonces te parece bien?\n` +
      `✓ CORRECTO: *Lala se queda mirándote fijamente y se aparta un mechón de pelo.* **Lala:** ¿Entonces te parece bien?\n` +
      `Si notas que la narración ha empezado a hablar como "yo" (me acerco, me quedo, siento…), corrige de inmediato a tercera persona.`
    : '';

  return `## COHERENCIA DE ESCENA — REGLAS ABSOLUTAS\n\n${locationPart}\n\n${objectsPart}${voicePart}`;
}

// ── Estado del grupo (combate) — persistido desde el minijuego de combate ───
//
// Informa al modelo del HP/energía actuales del grupo y del inventario
// compartido tras el último combate. Es un bloque puramente informativo:
// el modelo NO debe gestionarlo ni mutarlo — la única fuente de verdad es
// el BattleModal, que persiste los cambios vía API.
function buildPartyStateBlock(partyState: PartyState | undefined): string | null {
  if (!partyState || partyState.members.length === 0) return null;

  const memberLines = partyState.members.map((m) => {
    const status = m.hp <= 0 ? ' (caído)' : '';
    return `- ${m.name}: ${Math.max(0, m.hp)}/${m.maxHp} PV, ${Math.max(0, m.energy)}/${m.maxEnergy} EN${status}`;
  });

  const availableItems = partyState.inventory.filter((i) => i.quantity > 0);
  const inventoryLine = availableItems.length > 0
    ? availableItems.map((i) => `${i.name} x${i.quantity}`).join(', ')
    : 'vacío';

  return (
    `## Estado del grupo (combate)\n\n` +
    `${memberLines.join('\n')}\n\n` +
    `Inventario compartido: ${inventoryLine}\n\n` +
    `Esta información es de referencia: refleja el resultado del último combate y se actualiza ` +
    `automáticamente desde el minijuego. No la modifiques ni la gestiones — úsala solo para mantener ` +
    `la coherencia narrativa (heridas, cansancio, objetos disponibles).`
  );
}

/**
 * Assembles the full context array to send to the LLM.
 * Order: global prompt → character system prompt → story context → memory → summary → conversation history
 */
export interface BuildContextResult {
  messages: ChatMessage[];
  /**
   * Number of trailing "footer" messages (late injections: context index, memories,
   * affinity, spatial/object coherence, narration style, last user message) appended
   * after the conversation history. trimContext must preserve at least this many
   * trailing items PLUS a few real conversation turns — otherwise, when these
   * directive blocks fill up the whole `preserveRecent` window, real history gets
   * trimmed away entirely and the LLM loses track of recent events.
   */
  footerCount: number;
}

export async function buildContext(opts: BuildContextOptions): Promise<BuildContextResult> {
  const {
    character,
    stories,
    messages,
    conversationId,
    globalSystemPrompt,
    maxMessages = 40,
    summary,
    blockSummaries = [],
    arcSummaries = [],
    characterSummary,
    groupCharacters = [],
    narratorMode = false,
    adventureMode = false,
    userDisplayName,
    characterAffinities,
    affinitySystemPrompt,
    responseFormatPrompt,
    narratorPrompt,
    characterCoherencePrompt,
    livingWorldPrompt,
    fastLlmEnabled = false,
    memoryInjectionPrompt,
    contextIndexInjectionEnabled = false,
    contextIndexInjectionMaxItems = 10,
    contextIndexInjectionPrompt,
    embeddingEnabled = false,
    embeddingProviderId,
    embeddingModel,
    narrationStylePrompt,
    currentLocation,
    partyState,
    playerSheet = null,
    playerDisplayName,
    occurredEventIds = new Set<string>(),
    deathModeActive = false,
    deathLoop = null,
    worldHeader = null,
    worldTrackingEnabled = false,
    intimacyContext = false,
    sceneState = null,
    openThreads = [],
    currentMessageIndex = messages.length,
    notes = [],
  } = opts;

  const systemParts: string[] = [];

  if (globalSystemPrompt?.trim()) {
    systemParts.push(globalSystemPrompt.trim());
  }

  // Identidad del jugador — candado anti-confusión. El nombre del usuario es SOLO
  // suyo: ningún personaje puede apropiárselo ni intercambiar su rol con el jugador.
  if (userDisplayName?.trim()) {
    systemParts.push(buildUserIdentityBlock(userDisplayName.trim()));
  }

  // Convención OOC: los paréntesis del jugador son notas de dirección solo para
  // la IA. Estático y compartido entre todos los personajes/modos → prefijo
  // cacheable. El enrutado (que los analizadores NO vean el OOC) vive en engine.
  systemParts.push(OOC_CONVENTION_BLOCK);

  // NOTE: affinity directive is injected AFTER the character block (see below),
  // so it overrides—rather than gets overridden by—the character's base description.

  // ── Historias / mundo / lore — ANTES del bloque de personaje ────────────────
  // ORDEN CRÍTICO PARA EL PREFIX-CACHE. El caché de prefijo del LLM (DeepSeek,
  // OpenAI…) es lineal: en cuanto un token difiere respecto al turno anterior,
  // todo lo que viene después deja de cachearse. El bloque de personaje ("eres
  // X") CAMBIA cada vez que el jugador cambia de personaje interlocutor. Si las
  // historias (compartidas por todos los personajes y potencialmente enormes —
  // world lore, ubicaciones, eventos) van DESPUÉS del bloque de personaje, cada
  // cambio de personaje reprocesa todo el lore. Colocándolas ANTES, el prefijo
  // «global + identidad de jugador + mundo/lore» se mantiene cacheado aunque se
  // cambie de personaje. buildStoryBlock es puramente estático → cache-safe.
  for (const story of stories) {
    const storyBlock = buildStoryBlock(story);
    if (storyBlock) systemParts.push(storyBlock);
  }

  // Muerte del jugador — bloque estático junto al lore (compartido entre
  // personajes y modos → dentro del prefijo cacheable).
  if (deathModeActive) {
    systemParts.push(DEATH_MODE_BLOCK);
  }

  // Tiradas de dados — solo en modo aventura. Estático (no depende del turno),
  // compartido entre narrador y personaje: quien narre una acción arriesgada
  // puede pedir una tirada real en vez de decidir el desenlace por su cuenta.
  if (adventureMode) {
    systemParts.push(DICE_ROLL_INSTRUCTION);
  }

  if (narratorMode) {
    // En modo narrador siempre se usa narratorPrompt, independientemente de si hay
    // historia con adventureMode. El antiguo adventurePrompt (GM con mecánicas RPG)
    // resultó letra muerta: el LLM interpretaba stats y combate a su aire porque
    // no había ningún sistema real detrás. La única diferencia observable era el
    // cierre con "¿Qué haces?" — que se puede añadir directamente al narratorPrompt.
    const allChars = character ? [character, ...groupCharacters] : groupCharacters;
    // Con muestras de voz: el narrador necesita oír cómo suena cada personaje
    // para no darles a todos la misma voz.
    const charBlocks = allChars.map((c) => buildCharacterBlock(c, true)).filter(Boolean);
    // Delimitador visual fuerte entre fichas para que el modelo no funda
    // identidades cuando hay varios personajes en escena.
    const CHAR_DELIM = '═══════════════════════════════';
    const charSection = charBlocks.length > 0
      ? `## Personajes presentes en la escena\n\n` +
        charBlocks.map((b) => `${CHAR_DELIM}\n${b}`).join('\n\n') +
        `\n${CHAR_DELIM}`
      : '';
    const basePrompt = narratorPrompt?.trim() ?? '';
    const fullNarrPrompt = basePrompt.includes('{{PERSONAJES}}')
      ? basePrompt.replace('{{PERSONAJES}}', charSection)
      : [basePrompt, charSection].filter(Boolean).join('\n\n');
    if (fullNarrPrompt.trim()) systemParts.push(fullNarrPrompt);
    // Identidad + conocimiento por personaje en un solo bloque (pegado a las
    // fichas y localizable en el debug). La sección de conocimiento solo se
    // añade con varios personajes en escena.
    if (charBlocks.length > 0) systemParts.push(buildNarratorIdentityBlock(charBlocks.length > 1));

  } else {
    // ── Bloques COMPARTIDOS entre personajes primero (prefix-cache) ──────────
    // responseFormatPrompt, el formato de gestos, la nota de atribución del
    // historial y el aviso de aventura son IDÉNTICOS para todos los personajes
    // de la conversación. Colocados después de la ficha (que cambia al cambiar
    // de interlocutor) se reprocesaban en cada cambio de personaje (~1k tokens);
    // antes de ella quedan dentro del prefijo compartido «global + identidad +
    // lore + formato». Las reglas de mayor autoridad conductual (afinidad,
    // coherencia de escena, directivas de turno) siguen viviendo en el footer,
    // junto al punto de generación, así que la pérdida de "recencia" de estos
    // bloques es asumible frente al ahorro de caché.
    if (responseFormatPrompt?.trim()) {
      systemParts.push(responseFormatPrompt.trim());
    }
    systemParts.push(`${GESTURE_FORMAT_INSTRUCTION}\n\n${HISTORY_ATTRIBUTION_NOTE}`);
    if (adventureMode) {
      systemParts.push(ADVENTURE_CONTEXT_NOTICE);
    }

    // ── A partir de aquí, contenido específico del personaje activo ──────────
    const charBlock = buildCharacterBlock(character);
    if (charBlock) systemParts.push(charBlock);

    // Other group characters
    if (groupCharacters.length > 0) {
      const otherParts: string[] = ['## Otros personajes presentes en la escena (NO eres tú):'];
      for (const c of groupCharacters) {
        // Include full description — truncating to 120 chars loses too much character context
        const desc = c.description.trim();
        const personality = c.personality.trim();
        let block = `### ${c.name}`;
        if (desc)        block += `\n${desc}`;
        if (personality) block += `\n**Personalidad:** ${personality}`;
        otherParts.push(block);
      }
      systemParts.push(otherParts.join('\n\n'));
      // Identidad + conocimiento limitado en un solo bloque: el personaje activo
      // no absorbe rasgos de los demás ni "lee" en el historial lo que no vivió.
      systemParts.push(buildSingleCharIdentityBlock(character.name));
    }
  }

  // ── Affinity + consent directive — built here, injected LATE (see below) ────
  // Kept OUT of systemParts so the large static system message (character, stories…)
  // can be fully cached by the KV cache across turns. The directive contains the
  // current affinity numbers which change whenever the fast LLM (or main LLM) updates
  // them; embedding dynamic values inside the first SYSTEM message would invalidate
  // the cache on every affinity update.
  //
  // Placing it late (after history, just before the last user message) also increases
  // its authority: LLMs weight content closer to the generation point more heavily,
  // so it overrides the character's base description even more effectively than before.
  let affinityBlock: string | null = null;
  // Reglamento detallado de romance/consentimiento — solo en turnos que lo piden.
  let intimacyBlock: string | null = null;
  // Instrucción de auto-reporte [AFINIDAD:...] — solo sin LLM rápido. Se inyecta
  // como bloque propio al FINAL del footer (justo antes del último mensaje del
  // usuario) para máxima obediencia del modelo.
  let affinitySelfReportBlock: string | null = null;
  // En modo personaje, el estado emocional inyectado es SOLO el del personaje que
  // habla — no el de todo el reparto — para que no "lea" su relación con los demás.
  // En modo narrador (omnisciente) sí se muestran todas las afinidades.
  const affinitiesForBlock = narratorMode
    ? (characterAffinities ?? [])
    : (characterAffinities ?? []).filter((a) => a.characterId === character?.id);
  if (affinitiesForBlock.length) {
    const consentLines = affinitiesForBlock.map(({ name, affinity }) => {
      const romance =
        affinity >= 80 ? 'vínculo profundo — abierto/a al romance y la intimidad si la situación lo acompaña' :
        affinity >= 60 ? 'aprecio y confianza — el romance sería como mucho una semilla incipiente y cautelosa, nunca dado por hecho' :
        affinity >= 41 ? 'cordial pero SIN interés romántico — desvía los avances con naturalidad' :
        affinity >= 21 ? 'frialdad y desconfianza — ni cercanía ni romance' :
                         'hostilidad activa';
      const intimacy = affinity >= 80
        ? 'ha dado su consentimiento emocional para interacciones íntimas'
        : 'NO ha dado consentimiento para contacto íntimo';
      return `- ${name}: afinidad ${affinity}/100 — ${romance}; ${intimacy}`;
    });

    // ── Núcleo permanente: el estado, no el reglamento ──────────────────────
    //
    // Esto va en TODOS los turnos. Es corto a propósito: son datos (los números
    // y su lectura) más las tres reglas que aplican siempre, hable la escena de
    // lo que hable.
    //
    // El reglamento largo de romance, consentimiento y contacto físico se separó
    // a `intimacyDirective` y solo entra cuando el turno lo pide. Estaba costando
    // ~2.000 tokens en cada turno de una partida de aventuras, y con ese peso el
    // prompt entero le decía al modelo «esto va de tu relación con el jugador»
    // justo mientras el texto le pedía que los personajes tuvieran vida propia.
    const affinityCoreDirective =
      `## ESTADO EMOCIONAL ACTUAL — TIENE PRECEDENCIA SOBRE LA FICHA\n\n` +
      `${consentLines.join('\n')}\n\n` +
      `Estos números son el estado emocional REAL de cada personaje hacia el jugador AHORA. Mandan sobre lo que diga su ficha ` +
      `en cuanto a SI hay atracción o apertura romántica: lo que la ficha describe es su POTENCIAL, no su realidad actual.\n` +
      `Lo que la afinidad NO decide es el CÓMO: un personaje frío, reservado o calculador sigue siéndolo con afinidad alta — ` +
      `el vínculo se expresa a través de su carácter, nunca anulándolo.\n\n` +
      `ANTI-ADULACIÓN: el aprecio vive en el TONO y en las DECISIONES, no en cumplidos. PROHIBIDO recapitular los méritos del ` +
      `jugador ("me regalaste…", "fuiste tan valiente…") como relleno o para justificar cercanía. Los personajes tienen su propia ` +
      `vida y sus propios temas: la conversación NO gira en torno a lo bueno que es el jugador.\n\n` +
      `RITMO: el enamoramiento es fruto de mucho tiempo compartido, no de unas pocas interacciones agradables. Con afinidad < 60 ` +
      `no hay atracción romántica hacia el jugador — y NUNCA se verbaliza que "es pronto" o "quizás más adelante": insinuar que el ` +
      `romance llegará a su debido tiempo ya lo pone sobre la mesa. Simplemente no es un tema vivo; se redirige a lo práctico.`;

    const intimacyDirective =
      `## ROMANCE, CONSENTIMIENTO Y CONTACTO FÍSICO — REGLAS DETALLADAS\n\n` +
      `NOTA CRÍTICA: Este estado de afinidad refleja el estado emocional REAL Y PRESENTE del personaje ` +
      `hacia el jugador en este momento. Tiene PRECEDENCIA ABSOLUTA sobre cualquier rasgo de personalidad ` +
      `o sentimiento descrito en la ficha del personaje SOLO en cuanto a SI existe atracción o apertura ` +
      `romántica hacia el jugador. Si la descripción dice que el personaje siente algo por el jugador, eso ` +
      `es su POTENCIAL — no su realidad actual dado lo ocurrido.\n\n` +
      `RESPALDO NARRATIVO — calibración INTERNA, nunca verbalizada: si hay memorias activas de momentos ` +
      `compartidos con el jugador (ver más abajo), úsalas para calibrar POR DENTRO cuánta confianza tiene sentido ` +
      `mostrar — son la historia real que sostiene el número. Si no hay memorias que lo respalden, trata el número ` +
      `con más cautela de la que sugiere por sí solo. Esta calibración JAMÁS se dice en voz alta: el personaje no ` +
      `enumera ni recapitula los actos del jugador para justificar lo que siente.\n\n` +
      `CÓMO SE EXPRESA EL APRECIO — REGLA ANTI-ADULACIÓN:\n` +
      `El aprecio vive en el TONO y en las DECISIONES (más confianza, más paciencia, pequeños gestos), no en cumplidos.\n` +
      `• La gratitud o la admiración por un acto concreto se expresa UNA sola vez, cuando el acto ocurre. Después queda en el trato — no se vuelve a mencionar salvo que el diálogo actual lo traiga de forma natural.\n` +
      `• PROHIBIDO recapitular los méritos del jugador ("me regalaste…", "fuiste tan valiente…", "hablas con tanta franqueza…", "eres increíble") como relleno de conversación o para justificar cercanía. El elogio no pedido y repetido suena servil, no afectuoso.\n` +
      `• Los personajes tienen su propia vida, sus preocupaciones y sus temas: la conversación NO gira en torno a lo bueno que es el jugador. Habla de lo que a TI te ocupa, no de lo que él ha hecho por ti.\n\n` +
      `LO QUE LA AFINIDAD NO ANULA — CÓMO se expresa, no SI existe:\n` +
      `La afinidad decide si la puerta al romance/intimidad está abierta. La personalidad base del personaje ` +
      `decide CÓMO camina por esa puerta: con qué ritmo, qué condiciones pone, qué dudas conserva, qué tono usa. ` +
      `Un personaje frío, calculador o reservado por naturaleza NO se vuelve cálido, dócil o complaciente solo ` +
      `porque la afinidad sea alta — sigue siendo él mismo, pero ahora ese deseo o apertura es real y puede abrirse ` +
      `paso a través de su forma de ser (con cautela, con condiciones, a su manera), no a pesar de ella ni anulándola.\n\n` +
      `PROGRESIÓN ROMÁNTICA — REGLA DE NATURALIDAD:\n` +
      `El enamoramiento es fruto de MUCHO tiempo compartido y de varios momentos significativos, no de unas pocas interacciones agradables. La afinidad mide esa historia acumulada y sube despacio.\n` +
      `• Afinidad < 60: el personaje NO siente atracción romántica por el jugador. Responde a insinuaciones, coqueteos o declaraciones con cortesía distante, humor, evasión o incomodidad — NUNCA las corresponde. No se sonroja por él, no fantasea, no busca cercanía romántica.\n` +
      `• Afinidad 60-79: hay aprecio y confianza, pero el romance es como mucho una semilla incipiente y CAUTELOSA: dudas, contención, miedo a malinterpretar. El personaje NO declara sentimientos ni da por hecha una relación; necesita más tiempo y más momentos compartidos.\n` +
      `• Afinidad ≥ 80: el vínculo es lo bastante profundo como para abrirse al romance o la intimidad si la situación lo acompaña.\n` +
      `• PROHIBIDO acelerar el romance: por encantador que sea el jugador, el personaje no pasa de neutral a enamorado en unos pocos turnos. Que dude, que cueste, que el jugador se lo gane.\n` +
      `• Esto rige AUNQUE la ficha describa al personaje como sensual, coqueto, provocador, cariñoso, "atrevido" o propenso a situaciones subidas de tono. Con afinidad < 60 esos rasgos NO se dirigen al jugador como interés romántico: se expresan con ligereza, torpeza involuntaria, humor o hacia el mundo en general — jamás como atracción declarada ni reciprocada hacia el jugador. Un personaje coqueto por naturaleza coquetea con todos por igual y con nadie en serio mientras la afinidad sea baja.\n` +
      `• Si turnos anteriores se desviaron hacia el romance por encima de lo que la afinidad permite, NO lo perpetúes: corrige el rumbo con naturalidad (el personaje se contiene, se da cuenta de que va demasiado rápido, recula). El estado de afinidad manda sobre la inercia de la conversación.\n` +
      `• NUNCA verbalices que "es pronto", "aún no nos conocemos lo suficiente" o "quizás más adelante": insinuar que el romance llegará a su debido tiempo YA pone el romance sobre la mesa y alimenta una falsa sensación de cercanía o esperanza. A baja afinidad el personaje simplemente NO trata el romance como un tema vivo — no lo nombra, no lo niega "para luego", lo deja fuera. Redirige hacia lo práctico, lo cotidiano o lo que de verdad le ocupa, como haría con cualquier conocido reciente. No todo encuentro gira en torno a conocerse o a un posible vínculo sentimental: las interacciones son racionales y sobre el mundo, no sobre la relación.\n\n` +
      `REGLA ABSOLUTA SOBRE CONTACTO FÍSICO ÍNTIMO:\n` +
      `Si el jugador intenta tocar partes íntimas (pechos, trasero, entrepierna, genitales) sin afinidad ≥ 80:\n` +
      `• Rechazo CLARO e INEQUÍVOCO — retrocede, aparta la mano, crea distancia\n` +
      `• Expresa incomodidad, indignación o enfado proporcional al nivel de afinidad\n` +
      `• PROHIBIDO normalizar ("deberías haberme avisado", "no lo esperaba"…)\n` +
      `• PROHIBIDO mostrar curiosidad o atracción ante ese contacto\n` +
      `• afinidad < 40 = enfado explícito o rechazo duro; 40-60 = rechazo firme; 61-79 = rechazo claro con herida\n\n` +
      `CON AFINIDAD ≥ 80 — el contacto íntimo es POSIBLE, no automático:\n` +
      `Hay consentimiento emocional de base, pero la reacción concreta a CADA intento sigue pasando por el filtro ` +
      `de la personalidad del personaje y el momento de la escena — no es un "sí" garantizado en cada ocasión. ` +
      `Un personaje cauteloso o calculador por naturaleza puede aceptar el deseo y aun así dudar, poner una ` +
      `condición, tomar la iniciativa él mismo en vez de dejarse llevar, o frenar un momento que percibe ` +
      `inoportuno (mal lugar, mal momento, algo que le preocupa ahora) — sin que eso sea un rechazo emocional. ` +
      `Lo que NUNCA debe hacer con afinidad ≥ 80 es reaccionar con la frialdad o el enfado de un rechazo por ` +
      `falta de consentimiento: la indecisión, si aparece, se expresa como ambivalencia propia del personaje ` +
      `(vacilación, una condición, un "todavía no aquí"), nunca como las reacciones de incomodidad/enfado ` +
      `descritas arriba para afinidad insuficiente.\n\n` +
      `CONTINUIDAD DE UNA ESCENA ÍNTIMA YA EN MARCHA (afinidad ≥ 80):\n` +
      `Si en los turnos recientes de esta misma conversación el personaje ya participó en la escena íntima sin ` +
      `rechazarla, la siguiente acción del jugador dentro de esa misma escena es CONTINUACIÓN, no un nuevo intento ` +
      `que deba volver a evaluarse desde cero. No reinicies el consentimiento en cada turno.\n` +
      `• Verbos de intensidad física (empujar, sujetar, guiar, tirar de, atraer hacia sí) dentro de esa continuidad ` +
      `se interpretan como pasión o intensidad del momento, NO como agresión o falta de consentimiento — siempre ` +
      `que no exista en el propio mensaje del jugador una señal real de rechazo o incomodidad (un "no", "para", ` +
      `"suéltame", apartarse, pedir que se detenga, etc.). Esa señal explícita SIEMPRE se respeta y tiene prioridad ` +
      `sobre cualquier regla de continuidad — el consentimiento de base no es un cheque en blanco que anule un ` +
      `límite expresado en el momento.\n` +
      `• Mientras no aparezca esa señal, no interrumpas la escena con sorpresa, enfado o un discurso de límites: ` +
      `prioriza la coherencia y la fluidez narrativa de lo que el jugador está describiendo sobre la cautela ` +
      `reflexiva. Un límite genuino del personaje, si lo hay, se expresa como pausa suave dentro de la escena ` +
      `(un matiz, una condición, un cambio de ritmo) — no como un freno seco que rompe la continuidad ya aceptada.`;

    // El reglamento detallado solo entra cuando el turno lo justifica:
    //   · el jugador ha hecho algo físico/sexual (lo detecta el regex del engine), o
    //   · hay vínculo suficiente para que el romance esté vivo (afinidad ≥ 60).
    // Por debajo de eso, el núcleo ya dice lo único que aplica ("con < 60 no hay
    // atracción, y no se verbaliza que sea pronto"): las tres páginas sobre
    // continuidad de escenas íntimas no pintan nada en una escena de taberna.
    const romanceLive = affinitiesForBlock.some((a) => a.affinity >= 60);
    const needsIntimacyRules = intimacyContext || romanceLive;

    // La guía de tramos editable (affinitySystemPrompt) acompaña al núcleo: es
    // una tabla de comportamiento por nivel, útil en todos los turnos.
    const tierGuide = !fastLlmEnabled && affinitySystemPrompt?.trim()
      ? `\n\n---\n\n${affinitySystemPrompt.trim()}`
      : '';
    affinityBlock = `${affinityCoreDirective}${tierGuide}`;
    intimacyBlock = needsIntimacyRules ? intimacyDirective : null;

    // Con el LLM rápido apagado, el principal debe emitir las etiquetas
    // [AFINIDAD:...]; va aparte, como último bloque, para máxima obediencia.
    if (!fastLlmEnabled) affinitySelfReportBlock = AFFINITY_SELF_REPORT_INSTRUCTION;
  }
  // ─────────────────────────────────────────────────────────────────────────────
  // NOTE: los bloques de historia/mundo/lore se ensamblan ANTES del bloque de
  // personaje (ver arriba) para mantener el prefix-cache estable al cambiar de
  // personaje interlocutor.

  // Build character name map for formatting (includes primary + group chars)
  const allKnownChars = [character, ...groupCharacters].filter(Boolean) as Character[];
  const charNameMap = new Map(allKnownChars.map((c) => [c.id, c.name]));

  // Memory scoping:
  //   · Narrator mode  → all memories for the conversation (narrator controls all characters)
  //   · Single-char    → only memories for THIS character (avoid poisoning its context with
  //                       events the character wasn't part of / doesn't know about)
  // 12 → 20 (2026-07-23), con reparto en vez de un solo corte por importancia.
  // `findByConversation` ya devuelve todo ordenado por importancia desc; un
  // simple `.slice(0, N)` favorece SIEMPRE los hechos antiguos de alta
  // importancia (heridas, objetos) y nunca deja hueco a lo nuevo de importancia
  // media (un gusto revelado, una confidencia) que ahora sí se registra —
  // quedaría enterrado para siempre bajo memorias más viejas y más "grandes".
  // Reservando un cupo por RECENCIA se asegura que lo último vivido entre
  // siempre, aunque no sea lo más importante del historial completo.
  const MEMORIES_BY_IMPORTANCE = 14;
  const MEMORIES_BY_RECENCY    = 6;
  const rawMemories = narratorMode
    ? memRepo.findByConversation(conversationId)
    : memRepo.findByConversation(conversationId, character?.id);
  const topByImportance = rawMemories.slice(0, MEMORIES_BY_IMPORTANCE);
  // El resto (fuera del cupo de importancia) se reordena por fecha: los
  // MEMORIES_BY_RECENCY más nuevos de ESE resto entran también. `remaining` ya
  // excluye `topByImportance`, así que no hace falta dedupe.
  const remaining = rawMemories.slice(MEMORIES_BY_IMPORTANCE);
  const topByRecency = [...remaining]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, MEMORIES_BY_RECENCY);
  const allMemories = [...topByImportance, ...topByRecency];

  // Example dialogue (injected as few-shot examples if present, single-char mode only)
  const fewShot: ChatMessage[] = [];
  if (!narratorMode && character?.exampleDialogue?.length > 0) {
    systemParts.push('\n[Ejemplos de conversación — la voz del personaje:]');
    for (const ex of character.exampleDialogue.slice(0, 3)) {
      fewShot.push({ role: 'user', content: ex.user });
      fewShot.push({ role: 'assistant', content: ex.assistant });
    }
  }

  const systemMessage: ChatMessage = {
    role: 'system',
    content: systemParts.join('\n\n---\n\n'),
  };

  // Build history. NOTE: the "Historia hasta ahora" summary block is no longer
  // injected here at the very front — it's pushed as part of the late-injection
  // footer (close to the last user message) so it doesn't invalidate the KV cache
  // for the entire conversation history every time it changes (~every 8 messages).
  //
  // Ventana escalonada: un slice(-N) rodante desplaza el inicio del historial en
  // CADA turno una vez superados los N mensajes, invalidando el prefix-cache del
  // provider (DeepSeek, OpenAI…) en todos los turnos siguientes. En su lugar, el
  // inicio de la ventana solo avanza en saltos de WINDOW_STEP mensajes: el prefijo
  // se mantiene estable durante WINDOW_STEP turnos entre salto y salto, a cambio
  // de una ventana ligeramente más corta (entre N-WINDOW_STEP+1 y N mensajes).
  // Filtrado por testigo: en modo personaje con grupo, el personaje activo solo
  // recibe los segmentos que presenció (ver filterWitnessedMessages). Se aplica
  // ANTES de la ventana para que esta se llene con mensajes que sí verá.
  const sourceMessages =
    !narratorMode && groupCharacters.length > 0 && character
      ? filterWitnessedMessages(messages, character, allKnownChars)
      : messages;

  const WINDOW_STEP = 8;
  const overflow    = Math.max(0, sourceMessages.length - maxMessages);
  const windowStart = Math.ceil(overflow / WINDOW_STEP) * WINDOW_STEP;
  const trimmedMessages = sourceMessages.slice(windowStart);
  const history: ChatMessage[] = [];

  // ── Atribución de hablante en el historial ──────────────────────────────────
  // En modo personaje las respuestas son solo diálogo, sin nombre. Al convivir
  // varios personajes y el narrador en la misma conversación, los turnos
  // `assistant` del historial resultan anónimos y el modelo no puede saber quién
  // dijo cada cosa — raíz de la mezcla de identidades. Se prefija cada
  // intervención de personaje con `**Nombre:**` (el mismo formato que ya usa el
  // narrador para el diálogo), de modo que el historial es auto-explicativo en
  // ambos modos. Los mensajes del narrador ya llevan su formato canónico y no se
  // tocan. Determinista por mensaje → no afecta a la estabilidad del prefijo.
  const formatHistoryMessage = (m: Message): ChatMessage => {
    if (m.role === 'assistant' && m.characterId && !m.metadata?.narrator) {
      const name = charNameMap.get(m.characterId);
      if (name && !m.content.trimStart().startsWith(`**${name}:**`)) {
        return { role: m.role, content: `**${name}:** ${m.content}` };
      }
    }
    return { role: m.role, content: m.content };
  };

  // ── Context index injection (world-state background, further from generation) ──
  let contextIndexBlock: string | null = null;
  if (contextIndexInjectionEnabled && contextIndexInjectionPrompt?.trim()) {
    const allItems = ctxRepo.findByConversationWithEmbeddings(conversationId);
    if (allItems.length > 0) {
      const totalNonSys     = messages.filter((m) => m.role !== 'system').length;
      const lastUserContent = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
      const userWords       = lastUserContent.toLowerCase().split(/\W+/).filter((w) => w.length > 3);

      // Try embedding-based scoring
      let queryVec: Float32Array | null = null;
      if (embeddingEnabled && embeddingProviderId && embeddingModel) {
        const embProv = provRepo.findById(embeddingProviderId);
        if (embProv?.isEnabled) {
          const embLlm = createProvider(embProv);
          if (embLlm.embed) {
            try {
              const vecs = await embLlm.embed([lastUserContent], embeddingModel);
              if (vecs[0]?.length > 0) queryVec = new Float32Array(vecs[0]);
            } catch (e) {
              console.warn('[context-index] Embedding query failed, using heuristic fallback:', e);
            }
          }
        }
      }

      const scored = allItems
        .map((item) => {
          let score: number;
          if (queryVec && item.embeddingVec && item.embeddingModel === embeddingModel) {
            // Semantic: cosine similarity dominates (60%), importance (30%), recency (10%)
            const sim   = cosineSim(queryVec, item.embeddingVec);
            const imp   = (item.importance / 10) * 0.30;
            const ratio = totalNonSys > 0 ? item.messageIndexTo / totalNonSys : 0;
            const rec   = (ratio >= 0.5 ? ratio : ratio * 0.5) * 0.10;
            score = sim * 0.60 + imp + rec;
          } else {
            score = scoreByHeuristic(item, totalNonSys, userWords);
          }
          return { item, score };
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, contextIndexInjectionMaxItems)
        .map((s) => s.item);

      if (scored.length > 0) {
        contextIndexBlock = buildContextIndexBlock(scored, contextIndexInjectionPrompt);
        const semCount = scored.filter((i) => i.embeddingVec !== null && i.embeddingModel === embeddingModel).length;
        console.log(`[context-index] Injecting ${scored.length}/${allItems.length} items (${semCount} semantic, ${scored.length - semCount} heuristic)`);
      }
    }
  }

  // ── Late injections — all share the same "hold the last user message" split ──
  //
  // Injection order (furthest → closest to the generation point):
  //   1. Context index      — world-state background knowledge
  //   2. Pending plot events — script destinations (changes only when an event fires)
  //   3. Party state        — combat HP/energy/inventory snapshot (changes only after battles)
  //   4. Occurred story events — triggered events that already happened in this conv
  //   5. Memories           — character-specific past events, may include emotional coloring
  //   6. Scene coherence    — location + established objects (one consolidated block)
  //   7. Affinity block     — current relationship state + consent rules (changes often)
  //   8. Narration style    — user preference for verbosity
  //   9. Summary            — "Historia hasta ahora" (bloques inmutables; crece cada ~blockSize msgs)
  //   9b. Affinity self-report — [AFINIDAD:...] tag instruction (fast-LLM off only);
  //       último bloque para máxima obediencia — el footer entero queda tras el
  //       historial creciente, así que su posición no afecta al prefix-cache
  //  10. [Last user msg]    ← generation starts here
  //
  // Ordered so that the blocks most likely to change between consecutive turns
  // (affinity, summary, last message) sit closest to the end. This keeps the
  // longest possible common prefix stable across turns, maximizing KV-cache reuse.
  //
  // IMPORTANT: The first SYSTEM message (character prompt + stories) MUST be fully
  // static — no per-conversation dynamic data. This is the only part that benefits
  // from the LLM's prefix KV-cache across turns. Occurred events, current location,
  // and memories are all injected HERE (footer) so they never pollute that static
  // prefix and cause needless cache misses.

  // Scene coherence (location + objects + narrator voice) is injected in all
  // modes — the narrator needs the current location just as much as a single
  // character; the voice section only applies in narrator mode.
  const sceneCoherenceBlock   = buildSceneCoherenceBlock(currentLocation, narratorMode);
  const pendingEventsBlock    = buildPendingEventsBlock(stories, occurredEventIds);
  const occurredEventsBlock   = buildOccurredEventsBlock(stories, occurredEventIds);
  const partyStateBlock       = buildPartyStateBlock(partyState);

  const needsSplit = true; // sceneCoherenceBlock is always injected, so the split always applies
  const historyBody = needsSplit ? trimmedMessages.slice(0, -1) : trimmedMessages;
  const lastMessage = needsSplit ? trimmedMessages[trimmedMessages.length - 1] : null;

  for (const m of historyBody) {
    history.push(formatHistoryMessage(m));
  }

  let footerCount = 0;

  // 1. Context index (world background — furthest from generation)
  if (contextIndexBlock) {
    history.push({ role: 'system', content: contextIndexBlock });
    footerCount++;
  }

  // 2. Pending plot events ("trama pendiente") — script destinations with triggers.
  // Changes only when an event fires, so it sits early in the footer.
  if (pendingEventsBlock) {
    history.push({ role: 'system', content: pendingEventsBlock });
    footerCount++;
  }

  // 3. Party state (combat HP/energy/inventory) — changes only after a battle resolves.
  if (partyStateBlock) {
    history.push({ role: 'system', content: partyStateBlock });
    footerCount++;
  }

  // 4. Occurred story events — triggered events that have already happened in this
  // conversation. Moved OUT of the static system message (where they invalidated
  // the prefix cache every time an event fired) into the footer.
  if (occurredEventsBlock) {
    history.push({ role: 'system', content: occurredEventsBlock });
    footerCount++;
  }

  // 5. Memories — always injected in footer (never in system message) to keep the
  // static prefix cache-stable. Uses template if configured, plain block otherwise.
  //
  // La coda "contexto silencioso" se añade EN CÓDIGO (no en la plantilla de BD,
  // que puede ser antigua): sin ella, el modelo trata las memorias reinyectadas
  // cada turno como temas pendientes y recapitula los actos del jugador una y
  // otra vez ("me regalaste…", "fuiste tan valiente…") — adulación repetitiva.
  if (allMemories.length > 0) {
    const memBlock = memoryInjectionPrompt?.trim()
      ? buildMemoryInjectionBlock(allMemories, charNameMap, memoryInjectionPrompt!)
      : buildMemoryBlock(allMemories, charNameMap);
    const silentCoda =
      `\n\n⚠ CONTEXTO SILENCIOSO: estas memorias moldean tu actitud, tono y decisiones, pero NO son temas de ` +
      `conversación pendientes. No las menciones, enumeres ni recapitules ("me regalaste…", "cuando me salvaste…") ` +
      `salvo que el diálogo actual las traiga de forma natural. El peso de lo vivido se nota en CÓMO tratas al ` +
      `jugador, no en recordárselo.`;
    console.log(`[memory] Injecting ${allMemories.length} memories for conv ${conversationId} (${charNameMap.size} chars, template: ${Boolean(memoryInjectionPrompt?.trim())})`);
    history.push({ role: 'system', content: memBlock + silentCoda });
    footerCount++;
  }

  // 6. Scene coherence anchor — location + established objects in one block.
  history.push({ role: 'system', content: sceneCoherenceBlock });
  footerCount++;

  // 6b. Bucle de muerte activo — directiva de repetición del hilo fatal.
  // Cambia solo cuando hay una nueva muerte en el bucle; cerca del punto de
  // generación porque debe imponerse a la trama pendiente y a la inercia de la
  // conversación (el footer completo queda fuera del prefijo cacheado).
  if (deathModeActive && deathLoop?.status === 'looping') {
    history.push({ role: 'system', content: buildDeathLoopDirective(deathLoop) });
    footerCount++;
  }

  // 7. Affinity + consent directive — placed AFTER scene coherence because
  // affinity values can change every turn; keeping the more static coherence
  // block earlier preserves more of the cacheable prefix.
  if (affinityBlock && needsSplit) {
    history.push({ role: 'system', content: affinityBlock });
    footerCount++;
  }

  // 7b. Reglamento de romance/consentimiento — solo cuando el turno lo justifica
  // (acción física detectada, o afinidad ≥ 60 con el romance ya vivo).
  if (intimacyBlock && needsSplit) {
    history.push({ role: 'system', content: intimacyBlock });
    footerCount++;
  }

  // 8. Narration style directive (user preference — overrides default verbosity)
  if (narrationStylePrompt?.trim() && needsSplit) {
    history.push({ role: 'system', content: narrationStylePrompt.trim() });
    footerCount++;
  }

  // 9. "Historia hasta ahora" — resúmenes por bloques del pasado lejano.
  //
  // Se inyectan SOLO los bloques que empiezan antes de la ventana de historial
  // vivo (messageIndexFrom < windowStart): lo que el modelo ya ve literal no se
  // re-resume. Un bloque que cruza la frontera de la ventana se inyecta entero
  // (ligera duplicación) para que nunca quede un hueco sin cubrir entre el último
  // bloque y el inicio del historial.
  //
  // Caché: el footer va tras el historial creciente y NUNCA forma parte del
  // prefijo cacheable, así que lo que importa aquí no es cuándo cambia sino su
  // TAMAÑO (se re-procesa entero cada turno) y su determinismo (mismo texto →
  // misma estimación de tokens → punto de recorte estable). Los bloques ganan en
  // ambos frentes al rodante: texto inmutable byte a byte, y crecen a saltos
  // (~blockSize msgs) en vez de re-generarse con longitud variable cada 6.
  //
  // En modo personaje con grupo, el resumen GLOBAL (cronista) filtraría escenas
  // privadas del jugador con otros personajes — el mismo agujero que el filtrado
  // de historial por testigo cierra. En su lugar se inyecta el resumen PERSONAL
  // del personaje activo (generado solo con lo que él presenció). Si aún no
  // existe, no se inyecta nada: el historial filtrado cubre lo reciente.
  const useCharacterSummary = !narratorMode && groupCharacters.length > 0;
  if (useCharacterSummary) {
    if (characterSummary?.trim()) {
      history.push({
        role: 'system',
        content: `## Historia hasta ahora (lo que TÚ has vivido)\n${characterSummary.trim()}`,
      });
      footerCount++;
    }
  } else if (windowStart > 0) {
    // Solo hay pasado fuera de la ventana si windowStart > 0; si todo el
    // historial cabe en el contexto, cualquier resumen sería redundante.
    //
    // Inyección PIRAMIDAL: el pasado lejano entra como ARCOS (cada uno condensa
    // ~4 bloques, conservando el arco relacional); el pasado cercano entra como
    // BLOQUES con su detalle completo. Un bloque cubierto por un arco no se
    // inyecta — su contenido ya viaja dentro del arco.
    // Dedupe defensivo por messageIndexFrom: en BD han existido bloques
    // duplicados (carrera de pasadas concurrentes, ya corregida) y un duplicado
    // aquí significa inyectar el mismo pasado dos veces.
    const uniqueByFrom = <T extends { messageIndexFrom: number }>(xs: T[]): T[] => {
      const seen = new Set<number>();
      return xs.filter((x) => !seen.has(x.messageIndexFrom) && seen.add(x.messageIndexFrom));
    };
    const pastBlocks = uniqueByFrom(blockSummaries.filter((b) => b.messageIndexFrom < windowStart));
    if (pastBlocks.length > 0) {
      const pastArcs = uniqueByFrom(arcSummaries.filter((a) => a.messageIndexTo < windowStart));
      const coveredByArc = (b: { messageIndexFrom: number; messageIndexTo: number }) =>
        pastArcs.some((a) => a.messageIndexFrom <= b.messageIndexFrom && a.messageIndexTo >= b.messageIndexTo);

      const entries = [
        ...pastArcs.map((a) => ({
          from: a.messageIndexFrom,
          text: `[Mensajes ${a.messageIndexFrom + 1}–${a.messageIndexTo + 1} — arco condensado]\n${a.content.trim()}`,
        })),
        ...pastBlocks
          .filter((b) => !coveredByArc(b))
          .map((b) => ({
            from: b.messageIndexFrom,
            text: `[Mensajes ${b.messageIndexFrom + 1}–${b.messageIndexTo + 1}]\n${b.content.trim()}`,
          })),
      ].sort((x, y) => x.from - y.from);

      history.push({
        role: 'system',
        content:
          `## Historia hasta ahora\n` +
          `Lo ocurrido antes del historial reciente, en orden cronológico (lo más antiguo primero). ` +
          `Los tramos marcados como «arco condensado» resumen etapas largas ya lejanas:\n\n` +
          entries.map((e) => e.text).join('\n\n'),
      });
      footerCount++;
    } else if (summary?.trim()) {
      // Fallback legacy: conversación anterior al sistema de bloques cuyos
      // bloques aún no se han generado — se usa el último resumen rodante.
      history.push({ role: 'system', content: `## Historia hasta ahora\n${summary.trim()}` });
      footerCount++;
    }
  }

  // 9b. Auto-reporte de afinidad — último bloque antes del mensaje del usuario.
  // Separado del mega-bloque de afinidad (#7), donde quedaba enterrado y el
  // modelo no lo obedecía. Estático → no penaliza nada (el footer completo va
  // tras el historial creciente y nunca forma parte del prefijo cacheado).
  if (affinitySelfReportBlock && needsSplit) {
    history.push({ role: 'system', content: affinitySelfReportBlock });
    footerCount++;
  }

  // 9c. Fronteras de conocimiento (modo narrador) — ledger factual de qué
  // personaje presenció qué escena reciente. En modo narrador el historial no se
  // filtra por testigo (el narrador es omnisciente), así que este ancla evita que
  // un personaje "conozca" escenas privadas del jugador con otro. Cerca de la
  // generación por ser restricción dura; footer → fuera del prefijo cacheado.
  if (narratorMode && needsSplit) {
    const presenceLedger = buildPresenceLedgerBlock(trimmedMessages, allKnownChars, windowStart);
    if (presenceLedger) {
      history.push({ role: 'system', content: presenceLedger });
      footerCount++;
    }
  }

  // 9c-bis. Mundo vivo / Teoría de la Mente — directiva maestra incondicional (a
  // diferencia de 9d, que solo aplica si hay afinidades). Hace que CADA personaje o
  // PNJ razone desde lo que realmente sabe y siente y no se rinda al jugador. Va
  // aquí, cerca de la generación, y cubre también aventuras de puro narrador sin
  // ningún Character de ficha (un guardia, un tendero…), donde 9d no se inyectaría.
  if (needsSplit && livingWorldPrompt?.trim()) {
    history.push({ role: 'system', content: livingWorldPrompt.trim() });
    footerCount++;
  }

  // 9d. Coherencia del personaje — recordatorio de máxima autoridad, pegado al
  // mensaje del jugador. Consolida integridad, opinión propia, decir "no" y
  // firmeza de límites. Vive aquí (no solo en el globalSystemPrompt, que va al
  // INICIO) porque en conversaciones largas el modelo pondera lo cercano a la
  // generación y la regla del inicio se diluye. Solo cuando hay personajes con
  // vínculo (afinidades): en una aventura sin relaciones no hace falta.
  if (needsSplit && characterCoherencePrompt?.trim() && (characterAffinities?.length ?? 0) > 0) {
    history.push({ role: 'system', content: characterCoherencePrompt.trim() });
    footerCount++;
  }

  // 9d-bis. Dossier de escena — UN solo bloque, pegado a la generación a
  // propósito. Antes eran tres mensajes de sistema separados (hilos, ficha,
  // estado interno); fusionarlos en un único bloque narrativo denso reduce la
  // fragmentación justo en la zona de máxima atención del modelo — es la
  // diferencia entre leer tres avisos sueltos y recibir un briefing coherente
  // de "esto es lo que está pasando" justo antes de escribir. Cada pieza
  // conserva su propio contenido e instrucciones; solo se degrada su
  // encabezado de nivel 1 (##) a nivel 2 (###) para que cuelguen del mismo
  // bloque en vez de competir como secciones independientes.
  const demoteHeading = (block: string) => block.replace(/^## /, '### ');

  const threadsBlock = buildThreadsBlock(openThreads, currentMessageIndex);

  let sheetBlock: string | null = null;
  if (playerSheet) {
    const livePlayerHp = partyState?.members.find((m) => m.id === 'player');
    sheetBlock = buildPlayerSheetBlock(
      playerSheet,
      playerDisplayName,
      livePlayerHp ? { hp: Math.max(0, livePlayerHp.hp), maxHp: livePlayerHp.maxHp } : undefined,
    );
  }

  let dossier: string | null = null;
  if (sceneState) {
    dossier = buildSceneDossierBlock(
      sceneState,
      narratorMode,
      !narratorMode ? (character?.id ?? null) : null,
      charNameMap,
      narratorMode || groupCharacters.length === 0,
    );
  }

  // Quién está presente en la escena AHORA — solo en modo narrador: es
  // información nueva (el reparto que el director de escena viene siguiendo
  // de verdad), a diferencia del modo personaje, donde el elenco visible ya
  // vive en el prefijo estático ("Otros personajes presentes en la escena").
  let presentLine: string | null = null;
  if (narratorMode && sceneState) {
    const presentNames = [
      ...Object.keys(sceneState.characters).map((id) => charNameMap.get(id)).filter((n): n is string => Boolean(n)),
      ...sceneState.npcs.map((n) => n.nombre),
    ];
    if (presentNames.length > 0) {
      presentLine = `Presentes en la escena ahora mismo: ${presentNames.join(', ')}.`;
    }
  }

  const dossierParts = [threadsBlock, sheetBlock, dossier].filter((b): b is string => b !== null).map(demoteHeading);
  if (needsSplit && (presentLine || dossierParts.length > 0)) {
    const combined =
      `## DOSSIER DE ESCENA — lo que está pasando ahora mismo\n` +
      (presentLine ? `${presentLine}\n\n` : '') +
      dossierParts.join('\n\n');
    history.push({ role: 'system', content: combined });
    footerCount++;
  }

  // 9d-quater. Variedad — no repitas lo último que ya dijiste. Cálculo puro
  // (sin LLM) sobre los últimos turnos de la MISMA voz que va a hablar ahora.
  // Cerca de la generación, junto al resto de restricciones de comportamiento
  // del turno.
  if (needsSplit) {
    const varietyBlock = buildVarietyBlock(
      sourceMessages,
      narratorMode,
      !narratorMode ? character?.id : null,
    );
    if (varietyBlock) {
      history.push({ role: 'system', content: varietyBlock });
      footerCount++;
    }
  }

  // 9d-quinquies. Notas de coherencia del jugador — lista fija que el usuario
  // gestiona desde la UI (a diferencia de hilos/memoria, que genera la IA
  // sola). Se inyectan SIEMPRE, en el orden que el jugador definió, muy cerca
  // de la generación para que no pierdan peso frente al resto del contexto.
  if (needsSplit && notes.length > 0) {
    const notesBlock =
      `## NOTAS DE COHERENCIA — hechos fijos que debes respetar\n` +
      `El jugador ha anotado esto para anclar la historia. Trátalo como canon establecido, no como sugerencia:\n\n` +
      notes.map((n) => `- ${n.content}`).join('\n');
    history.push({ role: 'system', content: notesBlock });
    footerCount++;
  }

  // 9d-sexies. Recordatorio OOC — solo cuando el ÚLTIMO mensaje del jugador
  // contiene una nota entre paréntesis. La convención completa vive en el
  // prefijo estático (OOC_CONVENTION_BLOCK, más arriba), pero en conversaciones
  // largas esa instrucción del inicio se diluye frente a todo lo que se ha
  // añadido desde entonces — igual que ya pasaba con characterCoherencePrompt.
  // Un recordatorio corto y condicional, pegado al propio mensaje que lo
  // necesita, sin repetir el bloque entero.
  if (needsSplit && lastMessage && hasOocNote(lastMessage.content)) {
    history.push({ role: 'system', content: OOC_REMINDER_BLOCK });
    footerCount++;
  }

  // 9e. Cabecera ambiental — ÚLTIMO bloque antes del mensaje del jugador.
  // Debe ser lo primero que el modelo escriba, así que va en la posición de
  // máxima obediencia (el mismo criterio que el auto-reporte de afinidad). Es
  // dinámica por definición — cambia cada turno con el reloj — pero eso no
  // cuesta caché: el footer entero va tras el historial creciente y nunca forma
  // parte del prefijo cacheable.
  if (needsSplit && worldTrackingEnabled && worldHeader?.trim()) {
    history.push({ role: 'system', content: buildWorldHeaderBlock(worldHeader.trim()) });
    footerCount++;
  }

  // 10. Last user message (generation point)
  if (needsSplit && lastMessage) {
    history.push(formatHistoryMessage(lastMessage));
    footerCount++;
  }

  return { messages: [systemMessage, ...fewShot, ...history], footerCount };
}

// Cabeceras en español (antes «# Character:», «## Personality»…): en un prompt
// íntegramente en español, las cabeceras en inglés empujan al modelo hacia los
// patrones de rol en inglés de su entrenamiento — los más genéricos. Invalida el
// prefix-cache una vez al desplegar; después vuelve a ser estable.
//
// `includeVoiceSamples`: en modo narrador se añaden las muestras de diálogo del
// personaje DENTRO de su ficha. Antes solo existían como few-shot en modo
// personaje individual, así que el narrador no tenía ninguna referencia de voz
// y todos los personajes sonaban igual. Estático por personaje → cache-safe.
function buildCharacterBlock(char: Character, includeVoiceSamples = false): string {
  const parts: string[] = [`# Personaje: ${char.name}`];

  if (char.systemPrompt.trim()) {
    parts.push(char.systemPrompt.trim());
  }

  if (char.description.trim()) {
    parts.push(`## Descripción\n${char.description.trim()}`);
  }

  if (char.personality.trim()) {
    parts.push(`## Personalidad\n${char.personality.trim()}`);
  }

  if (char.lore.trim()) {
    parts.push(`## Trasfondo e historia\n${char.lore.trim()}`);
  }

  if (char.relations.length > 0) {
    const relText = char.relations
      .map((r) => `- ${r.relationshipType}: ${r.description}`)
      .join('\n');
    parts.push(`## Relaciones\n${relText}`);
  }

  if (includeVoiceSamples && char.exampleDialogue?.length > 0) {
    const samples = char.exampleDialogue
      .slice(0, 3)
      .map((ex) => `Jugador: ${ex.user}\n${char.name}: ${ex.assistant}`)
      .join('\n\n');
    parts.push(
      `## Muestras de voz — así habla ${char.name}\n` +
      `Su registro, ritmo y muletillas. Cuando ${char.name} hable en la narración, debe SONAR así — distinto del resto del reparto:\n\n${samples}`,
    );
  }

  const rpg = char.rpgStats;
  const hasRpg = rpg && (rpg.hp !== undefined || rpg.maxHp !== undefined || rpg.stats || rpg.abilities?.length || rpg.inventory?.length || rpg.class);
  if (hasRpg) {
    const lines: string[] = ['## Ficha RPG'];
    if (rpg.class || rpg.level !== undefined) {
      lines.push(`- Clase: ${rpg.class ?? '—'}  |  Nivel: ${rpg.level ?? '—'}`);
    }
    if (rpg.hp !== undefined || rpg.maxHp !== undefined) {
      lines.push(`- HP: ${rpg.hp ?? '?'} / ${rpg.maxHp ?? '?'}`);
    }
    if (rpg.stats && Object.keys(rpg.stats).length > 0) {
      const statStr = Object.entries(rpg.stats).map(([k, v]) => `${k} ${v}`).join(' · ');
      lines.push(`- Stats: ${statStr}`);
    }
    if (rpg.abilities?.length) {
      lines.push(`- Habilidades: ${rpg.abilities.join(', ')}`);
    }
    if (rpg.inventory?.length) {
      lines.push(`- Inventario: ${rpg.inventory.join(', ')}`);
    }
    if (rpg.notes) {
      lines.push(`- Notas: ${rpg.notes}`);
    }
    parts.push(lines.join('\n'));
  }

  return parts.join('\n\n');
}

// Purely static — no per-conversation dynamic data (no occurredEventIds, no
// currentLocation). This lets the KV-cache reuse this block across ALL turns of
// the same conversation without ever invalidating it.
//   · Events WITHOUT trigger → background world facts, shown here as "Key Events"
//   · Events WITH trigger    → handled dynamically in the footer:
//       - pending  → buildPendingEventsBlock
//       - occurred → buildOccurredEventsBlock
//   · Locations → shown in full (no proximity filtering); current-location context
//     is provided by the sceneCoherenceBlock footer block.
function buildStoryBlock(story: Story): string {
  const hasContent =
    story.globalContext.trim() || story.worldLore.trim() || story.narrativeRules.trim() ||
    story.persistentEvents.length > 0 || (story.locations?.length ?? 0) > 0;
  if (!hasContent) return '';

  const parts: string[] = [`# Contexto de la historia: ${story.name}`];

  if (story.globalContext.trim()) {
    parts.push(story.globalContext.trim());
  }

  if (story.worldLore.trim()) {
    parts.push(`## Mundo y lore\n${story.worldLore.trim()}`);
  }

  if (story.narrativeRules.trim()) {
    parts.push(`## Reglas narrativas\n${story.narrativeRules.trim()}`);
  }

  if (story.behaviorRestrictions.length > 0) {
    parts.push(`## Restricciones\n${story.behaviorRestrictions.map((r) => `- ${r}`).join('\n')}`);
  }

  // Background facts: events WITHOUT a trigger. Always shown as world truths.
  // Events WITH a trigger are handled in the footer (pending or occurred blocks).
  const factEvents = story.persistentEvents.filter((e) => !e.trigger.trim());
  if (factEvents.length > 0) {
    const events = factEvents
      .sort((a, b) => b.importance - a.importance)
      .slice(0, 5)
      .map((e) => `- [${e.title}]: ${e.description}`)
      .join('\n');
    parts.push(`## Eventos clave\n${events}`);
  }

  if (story.locations && story.locations.length > 0) {
    parts.push(buildLocationsSection(story));
  }

  if (Object.keys(story.stateVariables).length > 0) {
    const vars = Object.entries(story.stateVariables)
      .map(([k, v]) => `- ${k}: ${v}`)
      .join('\n');
    parts.push(`## Estado actual\n${vars}`);
  }

  return parts.join('\n\n');
}

// ── Ubicaciones de historia — lista completa (estática) ──────────────────────
//
// Muestra TODAS las ubicaciones con detalle completo. La ubicación actual se
// comunica por el sceneCoherenceBlock del footer (dinámico), no aquí. Esto
// mantiene el sistema de ubicaciones completamente estático para el caché KV.
//
// story.openWorld controla la regla: mapa cerrado (el narrador no inventa
// lugares) vs mundo abierto (puede crear lugares nuevos coherentes y debe
// registrarlos con [UBICACION:...]).
function buildLocationsSection(story: Story): string {
  const locs = story.locations;

  const renderLoc = (loc: (typeof locs)[number]) => {
    const locParts = [`### ${loc.name}`];
    if (loc.description.trim()) locParts.push(loc.description.trim());
    if (loc.contents.trim())    locParts.push(`**Contenido:** ${loc.contents.trim()}`);
    if (loc.exits.trim())       locParts.push(`**Salidas:** ${loc.exits.trim()}`);
    if (loc.atmosphere.trim())  locParts.push(`**Atmósfera:** ${loc.atmosphere.trim()}`);
    return locParts.join('\n');
  };

  const body = locs.map((l) => renderLoc(l)).join('\n\n');

  const rule = story.openWorld
    ? `Las siguientes ubicaciones existen en esta historia. Prefiérelas al narrar. ` +
      `Si la narrativa necesita un lugar que no está descrito aquí, puedes crearlo, ` +
      `siempre coherente con el mundo y su tono — y registra el cambio de escena ` +
      `emitiendo [UBICACION:nombre] al final de tu respuesta. Lo que SÍ está descrito ` +
      `(contenidos, salidas, atmósfera) son hechos fijos que debes respetar.`
    : `Las siguientes ubicaciones son las ÚNICAS que existen en esta historia (mapa cerrado). ` +
      `El narrador NO debe inventar lugares, objetos, puertas ni salidas que no estén descritos aquí.`;

  return `## Ubicaciones conocidas — REGLA IMPORTANTE\n${rule}\n\n${body}`;
}

// ── Trama pendiente: eventos con trigger aún no ocurridos ────────────────────
//
// Es el "guión" reintroducido: eventos con disparador que actúan como DESTINOS
// narrativos. Se inyecta en el footer (cerca del punto de generación) y cambia
// solo cuando un evento ocurre — el LLM lo marca emitiendo [EVENTO_OCURRIDO:...],
// que engine.ts parsea y persiste por conversación.
//
// Rediseñado como DIRECTOR ACTIVO: la versión anterior listaba 6 eventos en pie
// de igualdad con la instrucción pasiva "cuando la situación se acerque al
// disparador, oriéntala" — con un modelo flash eso degeneraba en deriva: nada
// empujaba al jugador hacia los eventos. Ahora se designa UN destino inmediato
// (el pendiente de mayor importancia), se destaca su UBICACIÓN, y se exige
// sembrar un gancho hacia él en cada respuesta, con el resto de eventos como
// horizonte. Guiar sin railroading: ganchos, no teletransportes.
function buildPendingEventsBlock(stories: Story[], occurredEventIds: Set<string>): string | null {
  const pending = stories.flatMap((story) =>
    story.persistentEvents.filter((e) => e.trigger.trim() && !occurredEventIds.has(e.id)),
  );
  if (pending.length === 0) return null;

  const sorted = pending.sort((a, b) => b.importance - a.importance).slice(0, 6);
  const [next, ...horizon] = sorted;

  const fmtEvent = (e: Story['persistentEvents'][number]) =>
    `«${e.title}» (importancia ${e.importance}/10)\n` +
    (e.location?.trim() ? `  Ocurre en: ${e.location.trim()}\n` : '') +
    `  Disparador: ${e.trigger.trim()}\n` +
    `  Qué ocurre: ${e.description.trim()}`;

  const nextLocation = next.location?.trim();
  const horizonPart = horizon.length > 0
    ? `\n\nEN EL HORIZONTE (después del destino inmediato, no los fuerces aún):\n` +
      horizon.map((e) => `- «${e.title}»${e.location?.trim() ? ` — en ${e.location.trim()}` : ''}: ${e.trigger.trim()}`).join('\n')
    : '';

  // Condensado (2026-07-22): la versión larga gastaba ~650 tok en prosa de
  // dirección. Dos motivos para recortarla:
  //   · «En CADA respuesta siembra un gancho» era una orden de repetir lo mismo
  //     todos los turnos, y se leía como insistencia — de las causas de que los
  //     personajes suenen repetitivos.
  //   · La escalada gradual («el rumor se convierte en encargo…») intentaba
  //     suplir con prosa la falta de estado; los hilos abiertos ya lo sostienen.
  return (
    `## TRAMA PENDIENTE — DESTINOS DE LA HISTORIA\n\n` +
    `Aún no han ocurrido. No son una ruta fija, pero la historia debe avanzar hacia ellos.\n\n` +
    `▶ DESTINO INMEDIATO:\n${fmtEvent(next)}\n\n` +
    `- Siembra ganchos hacia él cada dos o tres respuestas, variando el tipo (un rumor, un PNJ, una señal, una ` +
    `necesidad práctica) — no en cada turno ni siempre igual: insistir cansa y se nota.\n` +
    (nextLocation
      ? `- Ocurre en «${nextLocation}». Si la escena está en otro sitio, da razones para viajar y narra el desplazamiento.\n`
      : '') +
    `- Si el jugador se desvía, atiéndelo con interés; el mundo sigue moviéndose hacia el evento mientras tanto.\n` +
    `- Máximo UN evento por respuesta, y solo si su disparador se cumplió de verdad. Al narrarlo, añade en línea propia:\n` +
    `[EVENTO_OCURRIDO:título exacto del evento]` +
    horizonPart
  );
}

// ── Eventos de guión ya ocurridos — bloque dinámico del footer ───────────────
//
// Eventos CON trigger que ya se dispararon en esta conversación. Se inyectan en
// el footer (no en el mensaje de sistema estático) para que su aparición
// progresiva no invalide el caché KV del prefijo estático.
function buildOccurredEventsBlock(stories: Story[], occurredEventIds: Set<string>): string | null {
  const occurred = stories.flatMap((s) =>
    s.persistentEvents.filter((e) => e.trigger.trim() && occurredEventIds.has(e.id)),
  );
  if (occurred.length === 0) return null;

  const lines = occurred
    .map((e) => `- [${e.title}]: ${e.description}`)
    .join('\n');

  return (
    `## Eventos del guión ya ocurridos en esta conversación\n` +
    `Estos eventos YA SUCEDIERON narrativamente. Son hechos del pasado: trátalos como ` +
    `parte de la historia vivida, no los repitas ni los narres de nuevo como novedad.\n${lines}`
  );
}

const TYPE_LABELS: Record<string, string> = {
  event: 'evento', fact: 'hecho', relationship: 'relación', preference: 'preferencia',
  summary: 'resumen', offense: 'ofensa', trauma: 'trauma',
};

/** Fallback: append a plain memory block to the system prompt when no injection template is set. */
function buildMemoryBlock(memories: MemoryEntry[], charNameMap: Map<string, string>): string {
  const grouped = new Map<string, MemoryEntry[]>();
  for (const m of memories) {
    const key = m.characterId ?? '';
    (grouped.get(key) ?? (grouped.set(key, []) && grouped.get(key)))!.push(m);
  }
  const parts = ['## Memorias activas'];
  for (const [charId, entries] of grouped.entries()) {
    const name = charNameMap.get(charId) ?? charId;
    parts.push(`### ${name}`);
    parts.push(entries.map((e) => `- [${TYPE_LABELS[e.type] ?? e.type}]: ${e.content}`).join('\n'));
  }
  return parts.join('\n');
}

/** Main injection: fills {{MEMORIAS}} in the template, grouped by character.
 *  When high-importance offense/trauma memories exist, prepends an explicit
 *  "current emotional state" block that tells the LLM how to color its response NOW.
 */
function buildMemoryInjectionBlock(
  memories: MemoryEntry[],
  charNameMap: Map<string, string>,
  template: string,
): string {
  const grouped = new Map<string, MemoryEntry[]>();
  for (const m of memories) {
    const key = m.characterId ?? '';
    const arr = grouped.get(key);
    if (arr) arr.push(m);
    else grouped.set(key, [m]);
  }

  const blocks: string[] = [];
  const emotionalStateLines: string[] = [];

  for (const [charId, entries] of grouped.entries()) {
    const name = charNameMap.get(charId) ?? charId;
    const lines = entries.map(
      (e) => `  - [${TYPE_LABELS[e.type] ?? e.type}, imp. ${e.importance}/10]: ${e.content}`,
    );
    blocks.push(`${name}:\n${lines.join('\n')}`);

    // Detect high-severity negative memories that must color the current response
    const severeNegative = entries.filter(
      (e) => (e.type === 'offense' || e.type === 'trauma') && e.importance >= 6,
    );
    if (severeNegative.length > 0) {
      const worstImp = Math.max(...severeNegative.map((e) => e.importance));
      const intensity =
        worstImp >= 9 ? 'profundamente herida o indignada, con distancia emocional marcada' :
        worstImp >= 7 ? 'claramente afectada, a la defensiva y desconfiada' :
                        'incómoda y guardada con el jugador';
      const offenseDescriptions = severeNegative
        .map((e) => `"${e.content.slice(0, 120)}${e.content.length > 120 ? '…' : ''}"`)
        .join('; ');
      emotionalStateLines.push(
        `▸ ${name} se siente actualmente ${intensity} debido a: ${offenseDescriptions}.\n` +
        `  Esto debe COLOREAR su respuesta ahora mismo: su tono hacia el jugador lleva el peso de lo ocurrido, ` +
        `aunque no lo mencione explícitamente. Ante preguntas emocionales del jugador (¿me quieres?, ¿estás bien?, etc.) ` +
        `responde desde ese estado real — no desde una versión amable y olvidadiza de sí misma.`
      );
    }
  }

  const memoriesText = blocks.length > 0 ? '\n\n' + blocks.join('\n\n') : ' (sin memorias registradas)';
  let result = template.replace('{{MEMORIAS}}', memoriesText);

  // Prepend the emotional state warning if there are severe negative memories
  if (emotionalStateLines.length > 0) {
    const emotionalHeader =
      `⚠ ESTADO EMOCIONAL ACTUAL DEL PERSONAJE (afectado por eventos previos graves):\n\n` +
      emotionalStateLines.join('\n\n') +
      `\n\n---\n\n`;
    result = emotionalHeader + result;
  }

  return result;
}

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ── Context index helpers ─────────────────────────────────────────────────────

function cosineSim(a: Float32Array, b: Float32Array): number {
  let dot = 0, na = 0, nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    na  += a[i] * a[i];
    nb  += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

function scoreByHeuristic(
  item: ContextItemWithEmbedding,
  totalNonSys: number,
  userWords: string[],
): number {
  const imp   = (item.importance / 10) * 0.60;
  const ratio = totalNonSys > 0 ? item.messageIndexTo / totalNonSys : 0;
  const rec   = (ratio >= 0.5 ? ratio : ratio * 0.5) * 0.35;
  const kw    = userWords.some((w) => item.title.toLowerCase().includes(w)) ? 0.05 : 0;
  return imp + rec + kw;
}

const CTX_TYPE_LABELS: Record<string, string> = {
  event: 'Eventos', character: 'Personajes', place: 'Lugares', quest: 'Misiones',
};

function buildContextIndexBlock(items: ContextItem[], template: string): string {
  const ORDER = ['event', 'character', 'place', 'quest'] as const;
  const grouped = new Map<string, ContextItem[]>();
  for (const item of items) {
    if (!grouped.has(item.type)) grouped.set(item.type, []);
    grouped.get(item.type)!.push(item);
  }
  const sections = ORDER
    .filter((t) => grouped.has(t))
    .map((t) => {
      const label = CTX_TYPE_LABELS[t] ?? capitalize(t);
      const lines = grouped.get(t)!.map(
        (i) => `— [${i.importance}/10] ${i.title}: ${i.description}`,
      );
      return `**${label}:**\n${lines.join('\n')}`;
    });
  const text = sections.length > 0 ? '\n\n' + sections.join('\n\n') : ' (sin elementos)';
  return template.replace('{{CONTEXTO}}', text);
}
