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
  summary?: string | null;        // "Resumen de sucesos" — siempre se incluye antes del historial
  groupCharacters?: Character[];  // Otros personajes del grupo (para modo narrador y modo personaje)
  narratorMode?: boolean;         // true = prompt de narrador omnisciente
  adventureMode?: boolean;        // true = full GM/RPG behavior
  userDisplayName?: string;       // Nombre del usuario para inyectar en el contexto
  characterAffinities?: Array<{ characterId: string; name: string; affinity: number }>;
  affinitySystemPrompt?: string;
  responseFormatPrompt?: string;  // character mode: response format instruction
  narratorPrompt?: string;        // narrator mode (no adventure): full narrator instructions; use {{PERSONAJES}}
  adventurePrompt?: string;       // narrator mode + adventure: GM instructions; use {{PERSONAJES}}
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
Eres consciente de tu ficha RPG (stats, habilidades, inventario). Actúa de forma coherente con ellos en situaciones de combate, reto o tensión. Antes de hablar, describe brevemente entre paréntesis tu acción o gesto físico en tercera persona.`;

// ── Formato de acciones y gestos ─────────────────────────────────────────────
// Instrucción estática: garantiza que las descripciones de gestos y acciones
// físicas vayan siempre en tercera persona, incluso en modo personaje (donde
// el diálogo va en primera persona). Cacheada junto con el bloque de personaje.
const GESTURE_FORMAT_INSTRUCTION =
  `## Formato de acciones y gestos físicos\n` +
  `Cuando incluyas descripciones de acciones o gestos (entre asteriscos, paréntesis o como narración entre turnos de diálogo), escríbelas siempre en TERCERA PERSONA, nunca en primera:\n` +
  `- ✗ INCORRECTO: *me acaricio el pelo mirándote a los ojos y sonrío de forma pícara*\n` +
  `- ✓ CORRECTO: *se acaricia el pelo mirándote a los ojos y sonríe de forma pícara*\n` +
  `El diálogo hablado (lo que el personaje dice en voz alta) sí va en primera persona.\n` +
  `Si el personaje describe acciones del jugador/usuario, también en tercera persona ("se acerca", "alza la vista", "te toma de la mano").`;

// ── Bloque de coherencia de escena — inyectado en todos los modos ───────────
// Consolida en UN solo mensaje de sistema las reglas de coherencia espacial
// (ubicación + instrucción [UBICACION:...]) y de objetos establecidos. Un solo
// bloque reduce la fatiga de directivas en el footer (menos bloques "REGLA
// ABSOLUTA" compitiendo entre sí) y ahorra un mensaje del presupuesto.
function buildSceneCoherenceBlock(currentLocation: string | null | undefined): string {
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

  return `## COHERENCIA DE ESCENA — REGLAS ABSOLUTAS\n\n${locationPart}\n\n${objectsPart}`;
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
    groupCharacters = [],
    narratorMode = false,
    adventureMode = false,
    userDisplayName,
    characterAffinities,
    affinitySystemPrompt,
    responseFormatPrompt,
    narratorPrompt,
    adventurePrompt,
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

  // Inyectar nombre del usuario para que el personaje lo use en sus respuestas
  if (userDisplayName?.trim()) {
    systemParts.push(`Recuerda que el usuario se llama ${userDisplayName.trim()}, y que es uno más en la interacción.`);
  }

  // NOTE: affinity directive is injected AFTER the character block (see below),
  // so it overrides—rather than gets overridden by—the character's base description.

  if (narratorMode) {
    const allChars = character ? [character, ...groupCharacters] : groupCharacters;

    if (adventureMode) {
      // ── Game Master con mecánicas RPG ────────────────────────────────────
      const charBlocksText = allChars.map((c) => buildCharacterBlock(c)).filter(Boolean).join('\n\n---\n\n');
      const charSection = charBlocksText
        ? `## Personajes en la aventura:\n\n${charBlocksText}`
        : '';
      const basePrompt = adventurePrompt?.trim() ?? '';
      const gmPrompt = basePrompt.includes('{{PERSONAJES}}')
        ? basePrompt.replace('{{PERSONAJES}}', charSection)
        : [basePrompt, charSection].filter(Boolean).join('\n\n');
      if (gmPrompt.trim()) systemParts.push(gmPrompt);

    } else {
      // ── Narrador básico (sin aventura) ────────────────────────────────────
      const charBlocks = allChars.map((c) => buildCharacterBlock(c)).filter(Boolean);
      const charSection = charBlocks.length > 0
        ? `## Personajes presentes en la escena:\n\n${charBlocks.join('\n\n')}`
        : '';
      const basePrompt = narratorPrompt?.trim() ?? '';
      const fullNarrPrompt = basePrompt.includes('{{PERSONAJES}}')
        ? basePrompt.replace('{{PERSONAJES}}', charSection)
        : [basePrompt, charSection].filter(Boolean).join('\n\n');
      if (fullNarrPrompt.trim()) systemParts.push(fullNarrPrompt);
    }

  } else {
    // Single character definition
    const charBlock = buildCharacterBlock(character);
    if (charBlock) systemParts.push(charBlock);

    if (adventureMode) {
      systemParts.push(ADVENTURE_CONTEXT_NOTICE);
    }

    // Other group characters
    if (groupCharacters.length > 0) {
      const otherParts: string[] = ['## Otros personajes presentes en la escena:'];
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
    }

    if (responseFormatPrompt?.trim()) {
      systemParts.push(responseFormatPrompt.trim());
    }

    // Instrucción estática de formato de gestos — siempre al final del bloque
    // de personaje para máxima autoridad sobre la descripción base del char.
    systemParts.push(GESTURE_FORMAT_INSTRUCTION);
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
  if (characterAffinities?.length) {
    const consentLines = characterAffinities.map(({ name, affinity }) => {
      if (affinity >= 80) {
        return `- ${name}: afinidad ${affinity}/100 — ha dado su consentimiento emocional para interacciones íntimas`;
      }
      const tier =
        affinity >= 61 ? 'confianza y cercanía' :
        affinity >= 41 ? 'neutralidad' :
        affinity >= 21 ? 'frialdad y desconfianza' :
                         'hostilidad activa';
      return `- ${name}: afinidad ${affinity}/100 (${tier}) — NO ha dado consentimiento para contacto íntimo`;
    });

    const consentDirective =
      `## ESTADO EMOCIONAL ACTUAL — TIENE PRECEDENCIA SOBRE LA DESCRIPCIÓN BASE\n\n` +
      `${consentLines.join('\n')}\n\n` +
      `NOTA CRÍTICA: Este estado de afinidad refleja el estado emocional REAL Y PRESENTE del personaje ` +
      `hacia el jugador en este momento. Tiene PRECEDENCIA ABSOLUTA sobre cualquier rasgo de personalidad ` +
      `o sentimiento descrito en la ficha del personaje. ` +
      `Si la descripción dice que el personaje siente algo por el jugador, eso es su POTENCIAL — ` +
      `no su realidad actual dado lo ocurrido.\n\n` +
      `REGLA ABSOLUTA SOBRE CONTACTO FÍSICO ÍNTIMO:\n` +
      `Si el jugador intenta tocar partes íntimas (pechos, trasero, entrepierna, genitales) sin afinidad ≥ 80:\n` +
      `• Rechazo CLARO e INEQUÍVOCO — retrocede, aparta la mano, crea distancia\n` +
      `• Expresa incomodidad, indignación o enfado proporcional al nivel de afinidad\n` +
      `• PROHIBIDO normalizar ("deberías haberme avisado", "no lo esperaba"…)\n` +
      `• PROHIBIDO mostrar curiosidad o atracción ante ese contacto\n` +
      `• afinidad < 40 = enfado explícito o rechazo duro; 40-60 = rechazo firme; 61-79 = rechazo claro con herida`;

    // consentDirective (current state) always first so the LLM knows the real
    // emotional state before anything else.
    // affinitySystemPrompt (tier guide + [AFINIDAD:...] tag instruction) only
    // when fast LLM is OFF — it's meaningless (and wastes tokens) when the fast
    // LLM handles affinity analysis. Placed AFTER consentDirective so the tag
    // emission instruction is as close as possible to the generation point.
    affinityBlock = (!fastLlmEnabled && affinitySystemPrompt?.trim())
      ? `${consentDirective}\n\n---\n\n${affinitySystemPrompt.trim()}`
      : consentDirective;
  }
  // ─────────────────────────────────────────────────────────────────────────────

  // Active story contexts (sorted by priority).
  // buildStoryBlock is purely static — no dynamic params — so the system message
  // remains cacheable across turns even as events occur or location changes.
  for (const story of stories) {
    const storyBlock = buildStoryBlock(story);
    if (storyBlock) systemParts.push(storyBlock);
  }

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
  const trimmedMessages = messages.slice(-maxMessages);
  const history: ChatMessage[] = [];

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

  // Scene coherence (location + objects) is injected in all modes — the narrator
  // needs the current location just as much as a single character.
  const sceneCoherenceBlock   = buildSceneCoherenceBlock(currentLocation);
  const pendingEventsBlock    = buildPendingEventsBlock(stories, occurredEventIds);
  const occurredEventsBlock   = buildOccurredEventsBlock(stories, occurredEventIds);
  const partyStateBlock       = buildPartyStateBlock(partyState);

  const needsSplit = true; // sceneCoherenceBlock is always injected, so the split always applies
  const historyBody = needsSplit ? trimmedMessages.slice(0, -1) : trimmedMessages;
  const lastMessage = needsSplit ? trimmedMessages[trimmedMessages.length - 1] : null;

  for (const m of historyBody) {
    history.push({ role: m.role, content: m.content });
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
  if (allMemories.length > 0) {
    const memBlock = memoryInjectionPrompt?.trim()
      ? buildMemoryInjectionBlock(allMemories, charNameMap, memoryInjectionPrompt!)
      : buildMemoryBlock(allMemories, charNameMap);
    console.log(`[memory] Injecting ${allMemories.length} memories for conv ${conversationId} (${charNameMap.size} chars, template: ${Boolean(memoryInjectionPrompt?.trim())})`);
    history.push({ role: 'system', content: memBlock });
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
  if (summary?.trim()) {
    history.push({ role: 'system', content: `## Historia hasta ahora\n${summary.trim()}` });
    footerCount++;
  }

  // 10. Last user message (generation point)
  if (needsSplit && lastMessage) {
    history.push({ role: lastMessage.role, content: lastMessage.content });
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
