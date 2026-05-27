import type { ChatMessage, Character, Story, Message, MemoryEntry } from '@rpgspeak/shared';
import { MemoryRepository } from '../memory/memory.repository.js';

const memRepo = new MemoryRepository();

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
}

// ── Aviso de aventura para modo personaje individual (sin narrador) ─────────
const ADVENTURE_CONTEXT_NOTICE = `## Contexto de aventura activa
Eres consciente de tu ficha RPG (stats, habilidades, inventario). Actúa de forma coherente con ellos en situaciones de combate, reto o tensión. Antes de hablar, describe brevemente entre paréntesis tu acción o gesto físico en tercera persona.`;

/**
 * Assembles the full context array to send to the LLM.
 * Order: global prompt → character system prompt → story context → memory → summary → conversation history
 */
export function buildContext(opts: BuildContextOptions): ChatMessage[] {
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
  }

  // ── Affinity + consent directive — injected AFTER the character block ────────
  // Critical: placing this AFTER the character description ensures it overrides
  // the character's base personality (e.g. "madly in love") instead of being
  // overridden by it.
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

    if (!fastLlmEnabled && affinitySystemPrompt?.trim()) {
      systemParts.push(`${affinitySystemPrompt.trim()}\n\n${consentDirective}`);
    } else {
      systemParts.push(consentDirective);
    }
  }
  // ─────────────────────────────────────────────────────────────────────────────

  // Active story contexts (sorted by priority)
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

  // If no configurable injection prompt, fall back to appending a basic block to the system prompt
  if (allMemories.length > 0 && !memoryInjectionPrompt?.trim()) {
    systemParts.push(buildMemoryBlock(allMemories, charNameMap));
  }

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

  // Build history — inject summary section before actual messages
  const trimmedMessages = messages.slice(-maxMessages);
  const history: ChatMessage[] = [];

  if (summary?.trim()) {
    history.push({
      role: 'system',
      content: `## Historia hasta ahora\n${summary.trim()}`,
    });
  }

  // Inject memories just before the last user message when a template is configured.
  // This positions them at maximum recency so the LLM prioritises them over the system prompt.
  const shouldInjectMemories = allMemories.length > 0 && memoryInjectionPrompt?.trim();
  const historyBody  = shouldInjectMemories ? trimmedMessages.slice(0, -1) : trimmedMessages;
  const lastMessage  = shouldInjectMemories ? trimmedMessages[trimmedMessages.length - 1] : null;

  for (const m of historyBody) {
    history.push({ role: m.role, content: m.content });
  }

  if (shouldInjectMemories && lastMessage) {
    const injectionBlock = buildMemoryInjectionBlock(allMemories, charNameMap, memoryInjectionPrompt!);
    console.log(`[memory] Injecting ${allMemories.length} memories for conv ${conversationId} (${charNameMap.size} chars)`);
    history.push({ role: 'system', content: injectionBlock });
    history.push({ role: lastMessage.role, content: lastMessage.content });
  } else if (allMemories.length > 0) {
    console.log(`[memory] Skipped injection — memories: ${allMemories.length}, prompt set: ${Boolean(memoryInjectionPrompt?.trim())}`);
  }

  return [systemMessage, ...fewShot, ...history];
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

function buildStoryBlock(story: Story): string {
  if (!story.globalContext.trim() && !story.worldLore.trim() && !story.narrativeRules.trim()) {
    return '';
  }

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

  if (story.persistentEvents.length > 0) {
    const events = story.persistentEvents
      .sort((a, b) => b.importance - a.importance)
      .slice(0, 5)
      .map((e) => `- [${e.title}]: ${e.description}`)
      .join('\n');
    parts.push(`## Key Events\n${events}`);
  }

  if (Object.keys(story.stateVariables).length > 0) {
    const vars = Object.entries(story.stateVariables)
      .map(([k, v]) => `- ${k}: ${v}`)
      .join('\n');
    parts.push(`## Current State\n${vars}`);
  }

  return parts.join('\n\n');
}

const TYPE_LABELS: Record<string, string> = {
  event: 'evento', fact: 'hecho', relationship: 'relación', preference: 'preferencia',
  summary: 'resumen', offense: 'ofensa', trauma: 'trauma',
};

/** Fallback: append a plain memory block to the system prompt when no injection template is set. */
function buildMemoryBlock(memories: MemoryEntry[], charNameMap: Map<string, string>): string {
  const grouped = new Map<string, MemoryEntry[]>();
  for (const m of memories) {
    (grouped.get(m.characterId) ?? (grouped.set(m.characterId, []) && grouped.get(m.characterId)))!.push(m);
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
    const arr = grouped.get(m.characterId);
    if (arr) arr.push(m);
    else grouped.set(m.characterId, [m]);
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
