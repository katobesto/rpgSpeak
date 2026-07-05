import type { ChatMessage, Character, Story, Message, MemoryEntry, ContextItem, PartyState } from '@rpgspeak/shared';
import { MemoryRepository } from '../memory/memory.repository.js';
import { ContextRepository, type ContextItemWithEmbedding } from '../../modules/context/context.repository.js';
import { ProviderRepository } from '../../modules/providers/provider.repository.js';
import { createProvider } from '../llm/provider.factory.js';

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
  summary?: string | null;        // Resumen GLOBAL (cronista) — narrador y modo personaje sin grupo
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
  /** IDs de eventos de historia (persistentEvents) ya ocurridos en esta conversación.
   *  Los eventos con trigger no ocurridos se inyectan como "trama pendiente" (destinos). */
  occurredEventIds?: Set<string>;
}

// ── Aviso de aventura para modo personaje individual (sin narrador) ─────────
const ADVENTURE_CONTEXT_NOTICE = `## Contexto de aventura activa
Eres consciente de tu ficha RPG (stats, habilidades, inventario). Actúa de forma coherente con ellos en situaciones de combate, reto o tensión. Si tu formato de respuesta permite describir acciones o gestos, hazlo brevemente entre paréntesis y en tercera persona antes de hablar; si tu formato es solo diálogo, transmite la tensión física del momento a través del tono y las palabras, sin añadir descripciones de acción.`;

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
    `### Conocimiento por personaje\n` +
    `Cada personaje solo conoce lo que presenció en primera persona: un recién incorporado ignora todo lo anterior a su llegada, y los momentos privados del jugador con un personaje no los conocen los demás. ` +
    `Cada vínculo con el jugador es independiente — no traslades dinámicas, sentimientos ni afinidades de un personaje a otro.`;
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
  `Cuando sí incluyas descripciones de acciones o gestos (entre asteriscos, paréntesis o como narración entre turnos de diálogo), escríbelas siempre en TERCERA PERSONA, nunca en primera:\n` +
  `- ✗ INCORRECTO: *me acaricio el pelo mirándote a los ojos y sonrío de forma pícara*\n` +
  `- ✓ CORRECTO: *se acaricia el pelo mirándote a los ojos y sonríe de forma pícara*\n` +
  `El diálogo hablado (lo que el personaje dice en voz alta) sí va en primera persona.\n` +
  `Si el personaje describe acciones del jugador/usuario, también en tercera persona ("se acerca", "alza la vista", "te toma de la mano").`;

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

/** Devuelve solo los mensajes que `activeChar` presenció, con elipsis en los
 *  huecos. Exportada para reutilizarla en el resumen por personaje (engine). */
export function filterWitnessedMessages(messages: Message[], activeChar: Character): Message[] {
  const nameRe = nameMentionRegex(activeChar.name);
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
      witnessed = false; // escena privada con otro personaje
    } else {
      witnessed = nameRe.test(assistant.content); // narrador: presente si nombrado
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
const AFFINITY_SELF_REPORT_INSTRUCTION =
  `## ACTUALIZACIÓN DE AFINIDAD — OBLIGATORIO\n` +
  `No hay analizador externo: ERES TÚ quien registra los cambios de afinidad. Al FINAL de tu respuesta visible (NUNCA dentro de tu razonamiento interno), si este intercambio ha movido de verdad cómo se siente el personaje hacia el jugador, añade en una línea propia:\n` +
  `[AFINIDAD:NombreExacto:+N]   (usa -N si empeora)\n` +
  `Reglas:\n` +
  `- Nombre EXACTO del personaje; una etiqueta por personaje afectado.\n` +
  `- Magnitudes CONTENIDAS, el afecto sube DESPACIO: +1 o +2 para un gesto amable o una charla que acerca; +3 a +5 para un momento significativo (confianza real, ayuda genuina); +6 a +10 SOLO para hechos excepcionales (salvar la vida, sacrificio, confesión sincera y correspondida). Negativos simétricos para frialdad, ofensas, traición o avances no deseados.\n` +
  `- Prioriza incrementos pequeños (+1/+2): subir mucho de golpe rompe la naturalidad de la relación.\n` +
  `- Si nada relevante cambió, NO pongas etiqueta. No la menciones ni la expliques en la narrativa.`;

// ── Bloque de coherencia de escena — inyectado en todos los modos ───────────
// Consolida en UN solo mensaje de sistema las reglas de coherencia espacial
// (ubicación + instrucción [UBICACION:...]) y de objetos establecidos. Un solo
// bloque reduce la fatiga de directivas en el footer (menos bloques "REGLA
// ABSOLUTA" compitiendo entre sí) y ahorra un mensaje del presupuesto.
function buildSceneCoherenceBlock(currentLocation: string | null | undefined, narratorMode = false): string {
  const locationPart = currentLocation?.trim()
    ? `### Ubicación actual\n` +
      `La acción transcurre en: **${currentLocation.trim()}**\n` +
      `Los personajes están en este lugar. Sus acciones, percepciones y referencias ` +
      `deben ser coherentes con ese entorno. No cambies el escenario de forma ` +
      `arbitraria ni teleportes a los personajes; los desplazamientos se narran.\n` +
      `Si la narrativa lleva explícitamente a los personajes a un lugar claramente distinto, ` +
      `escribe al final de tu respuesta (no en medio):\n` +
      `[UBICACION:nombre del nuevo lugar]\n` +
      `No emitas [UBICACION:...] si la escena continúa en el mismo lugar.`
    : `### Ubicación de la escena\n` +
      `La ubicación aún no está registrada. Si tu respuesta sitúa la acción en un ` +
      `lugar concreto, indícalo al final de tu respuesta con:\n` +
      `[UBICACION:nombre del lugar]\n` +
      `Una vez establecida, los personajes permanecerán en ese lugar hasta que ` +
      `la narrativa los lleve explícitamente a otro.`;

  const objectsPart =
    `### Objetos y elementos establecidos\n` +
    `Cuando un objeto o elemento relevante (llaves, armas, objetos mágicos, pertenencias, pistas…) ` +
    `ya ha sido descrito —su aspecto, ubicación, quién lo lleva o para qué sirve— esos detalles son ` +
    `HECHOS FIJOS. No los reinventes, reubiques ni les asignes otra función sin que la narrativa lo ` +
    `justifique de forma explícita (alguien lo mueve, lo entrega, lo usa, lo pierde). ` +
    `Si no recuerdas un detalle concreto, no inventes uno nuevo — deja la incógnita abierta o ` +
    `reutiliza lo último que se dijo.`;

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
    characterSummary,
    groupCharacters = [],
    narratorMode = false,
    adventureMode = false,
    userDisplayName,
    characterAffinities,
    affinitySystemPrompt,
    responseFormatPrompt,
    narratorPrompt,
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
    occurredEventIds = new Set<string>(),
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

  if (narratorMode) {
    // En modo narrador siempre se usa narratorPrompt, independientemente de si hay
    // historia con adventureMode. El antiguo adventurePrompt (GM con mecánicas RPG)
    // resultó letra muerta: el LLM interpretaba stats y combate a su aire porque
    // no había ningún sistema real detrás. La única diferencia observable era el
    // cierre con "¿Qué haces?" — que se puede añadir directamente al narratorPrompt.
    const allChars = character ? [character, ...groupCharacters] : groupCharacters;
    const charBlocks = allChars.map((c) => buildCharacterBlock(c)).filter(Boolean);
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

    const consentDirective =
      `## ESTADO EMOCIONAL ACTUAL — TIENE PRECEDENCIA SOBRE LA DESCRIPCIÓN BASE\n\n` +
      `${consentLines.join('\n')}\n\n` +
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

    // consentDirective (estado + gradación romántica + contacto físico) SIEMPRE.
    // Cuando el LLM rápido está OFF añadimos, al final (máxima autoridad):
    //   · la guía de tramos editable (affinitySystemPrompt), y
    //   · la instrucción concreta de auto-reporte de etiquetas [AFINIDAD:...].
    // Cuando está ON, el analizador externo gestiona la afinidad → no pedimos tags.
    if (!fastLlmEnabled) {
      const tierGuide = affinitySystemPrompt?.trim() ? `${affinitySystemPrompt.trim()}\n\n---\n\n` : '';
      affinityBlock = `${consentDirective}\n\n---\n\n${tierGuide}${AFFINITY_SELF_REPORT_INSTRUCTION}`;
    } else {
      affinityBlock = consentDirective;
    }
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
  const MAX_MEMORIES = 12; // cap to avoid context bloat
  const rawMemories = narratorMode
    ? memRepo.findByConversation(conversationId)
    : memRepo.findByConversation(conversationId, character?.id);
  const allMemories = rawMemories.slice(0, MAX_MEMORIES);

  // Example dialogue (injected as few-shot examples if present, single-char mode only)
  const fewShot: ChatMessage[] = [];
  if (!narratorMode && character?.exampleDialogue?.length > 0) {
    systemParts.push('\n[Example conversations:]');
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
      ? filterWitnessedMessages(messages, character)
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
  //   9. Summary            — "Historia hasta ahora" (rolling, changes every ~6 messages)
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

  // 7. Affinity + consent directive — placed AFTER scene coherence because
  // affinity values can change every turn; keeping the more static coherence
  // block earlier preserves more of the cacheable prefix.
  if (affinityBlock && needsSplit) {
    history.push({ role: 'system', content: affinityBlock });
    footerCount++;
  }

  // 8. Narration style directive (user preference — overrides default verbosity)
  if (narrationStylePrompt?.trim() && needsSplit) {
    history.push({ role: 'system', content: narrationStylePrompt.trim() });
    footerCount++;
  }

  // 9. Rolling summary ("Historia hasta ahora") — changes every ~6 messages, kept
  // close to the generation point so its periodic changes don't invalidate the
  // cache for the conversation history and earlier directive blocks.
  //
  // En modo personaje con grupo, el resumen GLOBAL (cronista) filtraría escenas
  // privadas del jugador con otros personajes — el mismo agujero que el filtrado
  // de historial por testigo cierra. En su lugar se inyecta el resumen PERSONAL
  // del personaje activo (generado solo con lo que él presenció). Si aún no
  // existe, no se inyecta nada: el historial filtrado cubre lo reciente.
  const useCharacterSummary = !narratorMode && groupCharacters.length > 0;
  const summaryForContext = useCharacterSummary ? characterSummary : summary;
  if (summaryForContext?.trim()) {
    const header = useCharacterSummary
      ? `## Historia hasta ahora (lo que TÚ has vivido)`
      : `## Historia hasta ahora`;
    history.push({ role: 'system', content: `${header}\n${summaryForContext.trim()}` });
    footerCount++;
  }

  // 10. Last user message (generation point)
  if (needsSplit && lastMessage) {
    history.push(formatHistoryMessage(lastMessage));
    footerCount++;
  }

  return { messages: [systemMessage, ...fewShot, ...history], footerCount };
}

function buildCharacterBlock(char: Character): string {
  const parts: string[] = [`# Character: ${char.name}`];

  if (char.systemPrompt.trim()) {
    parts.push(char.systemPrompt.trim());
  }

  if (char.description.trim()) {
    parts.push(`## Description\n${char.description.trim()}`);
  }

  if (char.personality.trim()) {
    parts.push(`## Personality\n${char.personality.trim()}`);
  }

  if (char.lore.trim()) {
    parts.push(`## Lore & Background\n${char.lore.trim()}`);
  }

  if (char.relations.length > 0) {
    const relText = char.relations
      .map((r) => `- ${r.relationshipType}: ${r.description}`)
      .join('\n');
    parts.push(`## Relationships\n${relText}`);
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

  const parts: string[] = [`# Story Context: ${story.name}`];

  if (story.globalContext.trim()) {
    parts.push(story.globalContext.trim());
  }

  if (story.worldLore.trim()) {
    parts.push(`## World & Lore\n${story.worldLore.trim()}`);
  }

  if (story.narrativeRules.trim()) {
    parts.push(`## Narrative Rules\n${story.narrativeRules.trim()}`);
  }

  if (story.behaviorRestrictions.length > 0) {
    parts.push(`## Restrictions\n${story.behaviorRestrictions.map((r) => `- ${r}`).join('\n')}`);
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
    parts.push(`## Key Events\n${events}`);
  }

  if (story.locations && story.locations.length > 0) {
    parts.push(buildLocationsSection(story));
  }

  if (Object.keys(story.stateVariables).length > 0) {
    const vars = Object.entries(story.stateVariables)
      .map(([k, v]) => `- ${k}: ${v}`)
      .join('\n');
    parts.push(`## Current State\n${vars}`);
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
function buildPendingEventsBlock(stories: Story[], occurredEventIds: Set<string>): string | null {
  const pending = stories.flatMap((story) =>
    story.persistentEvents.filter((e) => e.trigger.trim() && !occurredEventIds.has(e.id)),
  );
  if (pending.length === 0) return null;

  const top = pending.sort((a, b) => b.importance - a.importance).slice(0, 6);
  const lines = top.map(
    (e) =>
      `- «${e.title}» (importancia ${e.importance}/10)\n` +
      `  Disparador: ${e.trigger.trim()}\n` +
      `  Qué ocurre: ${e.description.trim()}`,
  );

  return (
    `## TRAMA PENDIENTE — DESTINOS NARRATIVOS\n\n` +
    `Los siguientes eventos de la historia AÚN NO HAN OCURRIDO. Son destinos hacia los que ` +
    `debe avanzar la narración — no una ruta fija, y NUNCA hechos del pasado:\n\n` +
    `${lines.join('\n\n')}\n\n` +
    `CÓMO USARLOS:\n` +
    `- NO los menciones ni narres como si ya hubieran pasado\n` +
    `- Cuando la situación se acerque al disparador de un evento, orienta la escena hacia él de forma natural\n` +
    `- Como mucho UN evento puede ocurrir por respuesta, y solo si su disparador se ha cumplido\n` +
    `- Cuando narres efectivamente uno de estos eventos, añade al final de tu respuesta (línea separada):\n` +
    `[EVENTO_OCURRIDO:título exacto del evento]\n` +
    `- No emitas esa etiqueta si el evento aún no ha sucedido en tu narración`
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
