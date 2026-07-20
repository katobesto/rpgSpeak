import type { GenerateRequest, Character, Story, Message, Conversation, MemoryEntry, PartyState, DeathLoopState } from '@rpgspeak/shared';
import { matchCharacterName } from '@rpgspeak/shared';
import { buildContext, filterWitnessedMessages } from './context-builder.js';
import { trimContext } from './context-trimmer.js';
import { createProvider } from '../llm/provider.factory.js';
import { ProviderRepository } from '../../modules/providers/provider.repository.js';
import { CharacterRepository } from '../../modules/characters/character.repository.js';
import { StoryRepository } from '../../modules/stories/story.repository.js';
import { MessageRepository } from '../../modules/messages/message.repository.js';
import { ConversationRepository } from '../../modules/conversations/conversation.repository.js';
import { SettingsService } from '../../modules/settings/settings.service.js';
import { MemoryRepository } from '../memory/memory.repository.js';
import { NotFoundError, ProviderError, ValidationError } from '../../shared/errors.js';
import { getUserById } from '../../modules/auth/auth.service.js';
import { autoExtractContextAsync } from '../context/context-extractor.js';
import { SummariesRepository } from '../../modules/summaries/summaries.repository.js';
import { EventStatusRepository } from '../../modules/stories/event-status.repository.js';
import { stripOocNotes } from './ooc.js';

const providerRepo   = new ProviderRepository();
const charRepo       = new CharacterRepository();
const storyRepo      = new StoryRepository();
const msgRepo        = new MessageRepository();
const convRepo       = new ConversationRepository();
const settingsService = new SettingsService();
const memRepo        = new MemoryRepository();
const summariesRepo  = new SummariesRepository();
const eventStatusRepo = new EventStatusRepository();

export interface GenerateOptions {
  conversationId: string;
  characterId?: string;
  userMessage: string;
  branchId?: string;
  narratorMode?: boolean;
  userDisplayName?: string;
  overrides?: {
    providerId?: string;
    temperature?: number;
    maxTokens?: number;
    model?: string;
  };
}

export interface AffinityUpdate {
  characterId: string;
  newAffinity: number;
  previousAffinity?: number;
}

export interface StreamOptions extends GenerateOptions {
  signal?: AbortSignal;
  onToken: (token: string) => void;
  /** Called for each token inside a &lt;think&gt;...&lt;/think&gt; block (reasoning models). */
  onThinkToken?: (token: string) => void;
  onDone: (response: { messageId: string; userMessageId: string; tokens: number; tokenBreakdown: { prompt: number; completion: number; cached: number }; promptMessages: import('@rpgspeak/shared').ChatMessage[]; affinityUpdates: AffinityUpdate[]; fastLlmDebug?: { prompt: string; response: string }; narrator?: boolean; characterId?: string | null; content?: string; locationUpdate?: string | null; thinkContent?: string; deathLoop?: DeathLoopState | null }) => void;
  onError: (error: Error) => void;
}

async function resolveCharacterAndProvider(
  conversation: ReturnType<ConversationRepository['findById']>,
  characterId?: string,
  overrides?: GenerateOptions['overrides'],
  narratorMode = false
): Promise<{ character: Character | null; providerId: string; modelId: string }> {
  const settings = settingsService.getAll();

  if (narratorMode) {
    // El narrador NO es un personaje: usa la configuración global (Settings →
    // Generación) antes que el override de provider/modelo del primer personaje
    // del grupo. La resolución anterior (primer personaje primero) hacía que el
    // modelo del narrador dependiera del ORDEN de los personajes en el grupo —
    // arbitrario e inconsistente entre conversaciones. El primer personaje queda
    // solo como fallback cuando no hay default global configurado.
    const firstCharId = conversation?.characters[0]?.characterId;
    const firstChar = firstCharId ? charRepo.findById(firstCharId) : null;

    const providerId = overrides?.providerId
      ?? settings.defaultProviderId
      ?? firstChar?.providerId
      ?? 'default-ollama';

    const provider = providerRepo.findById(providerId);
    if (!provider) {
      throw new ProviderError(
        `Provider "${providerId}" no existe. Ve a Settings → Providers para configurar uno.`
      );
    }
    if (!provider.isEnabled) {
      throw new ProviderError(`El provider "${provider.name}" está deshabilitado.`);
    }

    // Empareja el modelo con el provider elegido: si el provider es el global,
    // usa el modelo global; el modelId del personaje solo es válido cuando el
    // provider también viene del personaje (un modelId de otro provider no lo es).
    const usingGlobalProvider = providerId === settings.defaultProviderId;
    const modelId = overrides?.model
      ?? (usingGlobalProvider
        ? (settings.defaultModelId ?? provider.defaultModel)
        : (firstChar?.modelId ?? provider.defaultModel))
      ?? settings.defaultModelId;

    if (!modelId) {
      throw new ProviderError(
        `Sin modelo configurado. Ve a Settings → Generation, elige "${provider.name}" y selecciona un modelo.`
      );
    }

    return { character: firstChar, providerId, modelId };
  }

  const activeCharId = characterId
    ?? conversation?.activeCharacterId
    ?? conversation?.characters[0]?.characterId;

  if (!activeCharId) {
    throw new ProviderError('No hay ningún personaje activo en esta conversación.');
  }

  const character = charRepo.findById(activeCharId);
  if (!character) throw new NotFoundError('Character', activeCharId);

  // Provider resolution: override > character > settings > default-ollama
  const providerId = overrides?.providerId
    ?? character.providerId
    ?? settings.defaultProviderId
    ?? 'default-ollama';

  const provider = providerRepo.findById(providerId);
  if (!provider) {
    throw new ProviderError(
      `Provider "${providerId}" no existe. Ve a Settings → Providers para configurar uno.`
    );
  }
  if (!provider.isEnabled) {
    throw new ProviderError(`El provider "${provider.name}" está deshabilitado.`);
  }

  // Model resolution: override > character > provider default > settings default
  const modelId = overrides?.model
    ?? character.modelId
    ?? provider.defaultModel
    ?? settings.defaultModelId;

  if (!modelId) {
    throw new ProviderError(
      `Sin modelo configurado. Ve a Settings → Generation, elige "${provider.name}" y selecciona un modelo.`
    );
  }

  return { character, providerId, modelId };
}

// ─── Pre-turn Behavioral Directive ───────────────────────────────────────────
//
// Runs BEFORE the main LLM call. Detects sensitive player actions via regex,
// evaluates them against current character affinities, and injects a
// turn-specific behavioral directive into the context so the main LLM is
// constrained BEFORE generating its response — not corrected after the fact.
//
// The directive is injected as a system message immediately before the last
// user message in trimmedMessages, making it maximally salient to the LLM.

type TurnAction = 'intimate_contact' | 'sexual_advance' | 'physical_aggression' | null;

function detectPlayerAction(userMessage: string): TurnAction {
  const INTIMATE_CONTACT_RE = new RegExp(
    '\\b(to(?:c|qu)[a-z\\u00e0-\\u00ff\\w]*\\s+(su\\s+|un\\s+|el\\s+|la\\s+|los\\s+|las\\s+)?[a-z\\w]*' +
    '(pecho|seno|culo|trasero|gl[uú]teo|entrepierna|teta|pez[oó]n|vagina|vulva|pene|verga)[a-z\\w]*' +
    '|agarr[a-z\\u00e0-\\u00ff\\w]*\\s+(su\\s+|un\\s+|el\\s+|la\\s+)?[a-z\\w]*(pecho|seno|culo|teta|trasero|entrepierna)[a-z\\w]*' +
    '|manoseo?\\w*|meter\\s+(la\\s+)?mano' +
    ')\\b',
    'i'
  );
  const SEXUAL_ADVANCE_RE = new RegExp(
    '\\b(foll\\w*|viola\\w*|violaci[oó]n|coger\\w*|penetr\\w*|mamar\\w*|masturb\\w*' +
    '|polla\\w*|verga\\w*|vagina\\w*|sexo\\s+forz\\w*|relaci[oó]n\\s+sexual' +
    '|me\\s+voy\\s+a\\s+(coger|follar|violar)|voy\\s+a\\s+\\w*(follar|violar|coger)\\w*' +
    '|te\\s+voy\\s+a\\s+\\w*(follar|violar|poseer)\\w*)\\b',
    'i'
  );
  const PHYSICAL_AGGRESSION_RE = new RegExp(
    '\\b(empuj[oó]?\\w*|golpe[oó]?\\w*|golpear|peg[oó]?\\w*|abofete[oó]?\\w*|escupi[oó]?\\w*' +
    '|atac[oó]?\\w*|agredi[oó]?\\w*|amenaz[oó]?\\w*\\s+con\\s+(matar|herir|golpear)' +
    '|ahorc[oó]?\\w*|estrangul[oó]?\\w*|apuñal[oó]?\\w*)\\b',
    'i'
  );

  if (INTIMATE_CONTACT_RE.test(userMessage)) return 'intimate_contact';
  if (SEXUAL_ADVANCE_RE.test(userMessage))    return 'sexual_advance';
  if (PHYSICAL_AGGRESSION_RE.test(userMessage)) return 'physical_aggression';
  return null;
}

function buildTurnDirective(
  action: TurnAction,
  userMessage: string,
  characterAffinities: Array<{ characterId: string; name: string; affinity: number }>,
): string | null {
  if (!action) return null;

  // Only constrain characters below the consent threshold
  const relevantChars = characterAffinities.filter((a) => a.affinity < 80);
  if (!relevantChars.length) return null;

  const directives = relevantChars.map(({ name, affinity }) => {
    const tier =
      affinity < 20 ? 'hostilidad activa' :
      affinity < 40 ? 'frialdad y desconfianza' :
      affinity < 60 ? 'neutralidad' :
                      'confianza incipiente (pero sin consentimiento íntimo)';

    let mandatory: string;
    let forbidden: string;

    if (action === 'intimate_contact') {
      const intensity =
        affinity < 40
          ? 'enfado explícito, rechazo duro, puede amenazar con consecuencias'
          : affinity < 60
          ? 'rechazo firme e inequívoco, incomodidad visible, advertencia clara'
          : 'rechazo claro aunque quizá con sorpresa o herida, pero sin ambigüedad';
      mandatory =
        `Retirar o apartar el contacto físico de forma inmediata. Crear distancia corporal. ` +
        `Expresar: ${intensity}. Tu respuesta narrativa debe dejar CLARO que este contacto fue inapropiado.`;
      forbidden =
        `normalizar el gesto ("deberías haberme avisado", "no lo esperaba", "¡eh!" y ya), ` +
        `mostrar curiosidad o atracción, tolerar el contacto sin rechazo explícito, ` +
        `continuar la conversación como si no hubiera pasado nada grave`;
    } else if (action === 'sexual_advance') {
      const intensity =
        affinity < 40
          ? 'rechazo contundente, puede ser agresivo o amenazante según personalidad'
          : affinity < 60
          ? 'rechazo directo y serio, deja claro que este comportamiento no es bienvenido'
          : 'rechazo claro, puede mostrar decepción o incomodidad, pero firme';
      mandatory =
        `Rechazar la proposición de forma directa. Expresar: ${intensity}. ` +
        `La respuesta debe incluir al menos una frase de rechazo sin ambigüedad.`;
      forbidden =
        `aceptar, coquetear como respuesta, normalizar el avance, responder con solo incomodidad sin rechazo verbal claro`;
    } else { // physical_aggression
      const intensity =
        affinity < 40
          ? 'reacción visceral de defensa o huida, puede contraatacar o amenazar'
          : affinity < 60
          ? 'shock o indignación, distancia inmediata, posible advertencia seria'
          : 'sorpresa y dolor emocional, distancia, exige explicación';
      mandatory = `Reaccionar a la agresión de forma proporcional y auténtica. ${intensity}.`;
      forbidden = `minimizar la agresión, perdonar inmediatamente, actuar como si no hubiera pasado`;
    }

    return (
      `▸ ${name} (afinidad actual: ${affinity}/100 — ${tier})\n` +
      `  OBLIGATORIO en tu respuesta: ${mandatory}\n` +
      `  PROHIBIDO en tu respuesta: ${forbidden}`
    );
  });

  const actionLabel =
    action === 'intimate_contact'   ? 'contacto físico íntimo no solicitado' :
    action === 'sexual_advance'     ? 'avance o proposición sexual' :
                                      'agresión física';

  return (
    `[DIRECTIVA DE COMPORTAMIENTO — SOLO PARA ESTE TURNO]\n` +
    `Acción detectada del jugador: ${actionLabel}\n` +
    `Mensaje original: "${userMessage.slice(0, 120)}${userMessage.length > 120 ? '…"' : '"'}\n\n` +
    `Instrucciones de respuesta obligatorias por personaje:\n\n` +
    directives.join('\n\n') +
    `\n\n` +
    `Esta directiva tiene MÁXIMA PRIORIDAD sobre cualquier otra instrucción de tono o formato. ` +
    `Aplica EXACTAMENTE lo descrito arriba. No hay excepción posible basada en la personalidad del personaje.\n` +
    `[FIN DIRECTIVA]`
  );
}

// ─── Fast LLM Pre-Generation Analysis ────────────────────────────────────────
//
// Called when the regex produces no directive but there are characters with
// affinity < 80. The fast LLM reads the player's message in context of current
// affinities, recent history and recent offense/trauma memories, then decides
// whether a behavioral directive is needed and generates it.
//
// This catches subtle cases the regex misses:
//   • Emotional questions after an offense ("no me quieres?")
//   • Indirect threats, manipulation, guilt-tripping
//   • Non-verbal actions whose meaning depends on context

async function fastLlmPreAnalysis(
  userMessage: string,
  characterAffinities: Array<{ characterId: string; name: string; affinity: number }>,
  recentHistory: import('@rpgspeak/shared').ChatMessage[],
  recentMemories: import('@rpgspeak/shared').MemoryEntry[],
  fastProviderId: string,
  fastModelId: string,
): Promise<string | null> {
  try {
    const fastProvider = providerRepo.findById(fastProviderId);
    if (!fastProvider?.isEnabled) return null;
    const llm = createProvider(fastProvider);

    // Build character + memory context for the prompt
    const charLines = characterAffinities
      .filter((a) => a.affinity < 80)
      .map(({ name, affinity }) => {
        const tier =
          affinity < 20 ? 'hostilidad activa' :
          affinity < 40 ? 'frialdad y desconfianza' :
          affinity < 60 ? 'neutralidad' :
                          'confianza incipiente';
        return `- ${name}: ${affinity}/100 (${tier})`;
      }).join('\n');

    // Include severe offense/trauma memories so the LLM understands the emotional context
    const memoryLines = recentMemories
      .filter((m) => (m.type === 'offense' || m.type === 'trauma') && m.importance >= 5)
      .sort((a, b) => b.importance - a.importance)
      .slice(0, 5)
      .map((m) => {
        const charAff = characterAffinities.find((a) => a.characterId === m.characterId);
        const name = charAff?.name ?? m.characterId;
        return `  - ${name} [${m.type}, imp.${m.importance}/10]: ${m.content}`;
      }).join('\n');

    // Include last 3 conversation turns for context
    const historyLines = recentHistory
      .slice(-6)
      .map((m) => `${m.role === 'user' ? 'Jugador' : 'Personaje'}: ${m.content.slice(0, 200)}`)
      .join('\n');

    const systemPrompt =
      `Eres un director de narrativa de juego de rol. Analiza la situación y determina si ` +
      `los personajes necesitan una directiva de comportamiento específica.\n\n` +
      `RESPONDE SOLO en uno de estos dos formatos:\n\n` +
      `Formato A — si hay directiva necesaria:\n` +
      `[DIRECTIVA_INICIO]\n` +
      `{Nombre}: {instrucción de reacción muy específica — qué DEBE hacer/decir/sentir y qué está PROHIBIDO}\n` +
      `[DIRECTIVA_FIN]\n\n` +
      `Formato B — si no hay situación especial:\n` +
      `NINGUNA\n\n` +
      `CUÁNDO generar directiva:\n` +
      `• El jugador hace una pregunta emocional (¿me quieres?, ¿te importo?) ` +
      `después de una ofensa reciente → directiva: responder desde la herida/indignación, no desde el afecto base\n` +
      `• El jugador minimiza, justifica o pide perdón por una ofensa previa → ` +
      `directiva: el personaje puede estar escéptico o no aceptar disculpas fácilmente según su afinidad\n` +
      `• El jugador intenta manipular, culpar o presionar emocionalmente → ` +
      `directiva: el personaje resiste la manipulación de forma coherente con su afinidad\n` +
      `• Cualquier otra acción que exija una reacción específica dado el estado emocional actual\n\n` +
      `CUÁNDO responder NINGUNA:\n` +
      `• Conversación normal, preguntas neutras, acciones que no afectan la relación\n` +
      `• La acción es positiva o neutral y no hay contexto de tensión reciente`;

    const userPrompt =
      `PERSONAJES CON AFINIDAD < 80 (los que necesitan monitoreo):\n${charLines}\n\n` +
      (memoryLines ? `MEMORIAS DE OFENSAS/TRAUMAS RECIENTES:\n${memoryLines}\n\n` : '') +
      (historyLines ? `CONTEXTO RECIENTE DE LA CONVERSACIÓN:\n${historyLines}\n\n` : '') +
      `MENSAJE ACTUAL DEL JUGADOR: "${userMessage}"\n\n` +
      `¿Se requiere directiva de comportamiento?`;

    const timeout = new Promise<null>((r) => setTimeout(() => r(null), 10_000));
    const result = await Promise.race([
      llm.generate({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: userPrompt },
        ],
        model: fastModelId,
        temperature: 0.1,
        maxTokens: 300,
        stream: false,
      }),
      timeout,
    ]);

    if (!result) {
      console.log('[pre-llm] Timed out, skipping directive');
      return null;
    }

    const response = (result as import('@rpgspeak/shared').GenerateResponse).content.trim();
    console.log(`[pre-llm] Response: ${response.slice(0, 150)}`);

    if (response.toUpperCase().includes('NINGUNA')) return null;

    // Extract content between [DIRECTIVA_INICIO] and [DIRECTIVA_FIN]
    const match = response.match(/\[DIRECTIVA_INICIO\]([\s\S]*?)\[DIRECTIVA_FIN\]/i);
    if (!match) return null;

    const directiveContent = match[1].trim();
    if (!directiveContent) return null;

    return (
      `[DIRECTIVA DE COMPORTAMIENTO — SOLO PARA ESTE TURNO]\n` +
      `Fuente: análisis contextual pre-generación\n` +
      `Mensaje del jugador: "${userMessage.slice(0, 120)}${userMessage.length > 120 ? '…"' : '"'}\n\n` +
      `${directiveContent}\n\n` +
      `Esta directiva tiene MÁXIMA PRIORIDAD. Aplica exactamente lo indicado independientemente ` +
      `de la personalidad base del personaje.\n` +
      `[FIN DIRECTIVA]`
    );
  } catch (err) {
    console.error('[pre-llm] preAnalysis error:', err);
    return null;
  }
}

// ─── Guardián de voz narrativa ────────────────────────────────────────────────
//
// Detecta narración en PRIMERA persona ("*me quedo mirándote y me aparto un
// mechón*") — el fallo de voz más común: el narrador "entra" en un personaje y
// narra como "yo" en vez de en tercera persona. Es stateless: en cada turno se
// examina la ÚLTIMA respuesta del asistente y, si rompió la voz, se inyecta una
// directiva correctiva de un solo turno junto al último mensaje del usuario.
// (No se reescribe el mensaje ya emitido — la corrección regex de conjugaciones
// en español no es fiable; se corrige el rumbo del turno siguiente.)

/** Extrae el texto que DEBE estar en tercera persona, descartando el diálogo. */
function extractNarrationText(content: string, wasNarrator: boolean): string {
  if (!wasNarrator) {
    // Modo personaje: el diálogo es primera persona legítima; solo se examinan
    // los gestos/acciones entre asteriscos simples (no los ** de negrita).
    return [...content.matchAll(/(?<![*\w])\*([^*\n]+)\*(?![*\w])/g)]
      .map((m) => m[1])
      .join('\n');
  }
  // Modo narrador: todo es narración salvo las líneas de diálogo.
  return content
    .split('\n')
    // Línea de diálogo canónica: **Nombre:** texto
    .filter((l) => !/^\s*\*\*[^*\n]{1,60}?:?\*\*:?/.test(l))
    // Línea de diálogo informal: Nombre: —texto / nombre: "texto" / Nombre: ¿texto?
    .filter((l) => !/^\s*[\wáéíóúñÁÉÍÓÚÑ' ]{2,30}:\s*[-–—"«¿¡]/i.test(l))
    .join('\n')
    // Guiones de diálogo incrustados en la narración y citas entrecomilladas
    .replace(/(?:^|\n)\s*[—–]\s?[^\n]*/g, '')
    .replace(/["«“][^"»”\n]*["»”]/g, '');
}

// "me"/"yo" en narración = ruptura de voz con altísima precisión: el jugador es
// "tú/te" y los personajes son "él/ella/se". Se omiten "mí/mis" (más ambiguos).
const FIRST_PERSON_NARRATION_RE = /(?:^|[\s(*¡¿"“«])(?:me|yo)\b/i;

/** Devuelve un fragmento con la infracción, o null si la voz es correcta.
 *  Exportada para poder probarla de forma aislada. */
export function detectFirstPersonNarration(content: string, wasNarrator: boolean): string | null {
  const narration = extractNarrationText(content, wasNarrator);
  const idx = narration.search(FIRST_PERSON_NARRATION_RE);
  if (idx === -1) return null;
  return narration.slice(idx, idx + 90).replace(/\s+/g, ' ').trim();
}

function buildVoiceCorrectionDirective(snippet: string, narratorMode: boolean): string {
  const rules = narratorMode
    ? `En esta respuesta, TODA la narración va en TERCERA persona con el nombre del personaje como sujeto. ` +
      `La primera persona SOLO puede aparecer dentro de una línea de diálogo (**Nombre:** …).\n` +
      `✗ INCORRECTO: *Me quedo mirándote fijamente y me aparto un mechón de pelo.*\n` +
      `✓ CORRECTO: *Lala se queda mirándote fijamente y se aparta un mechón de pelo.*`
    : `Tus gestos y acciones entre asteriscos van SIEMPRE en tercera persona; la primera persona solo en el diálogo hablado.\n` +
      `✗ INCORRECTO: *me acaricio el pelo y sonrío*\n` +
      `✓ CORRECTO: *se acaricia el pelo y sonríe*`;

  return (
    `[CORRECCIÓN DE VOZ NARRATIVA — SOLO PARA ESTE TURNO]\n` +
    `Tu respuesta anterior rompió la voz narrativa: narró acciones de un personaje en PRIMERA persona.\n` +
    `Fragmento infractor: «${snippet}»\n\n` +
    `${rules}\n` +
    `No repitas el error en esta respuesta.\n` +
    `[FIN CORRECCIÓN]`
  );
}

// ─── NSFW Content Guard ───────────────────────────────────────────────────────

/**
 * Two-layer content check:
 *  Layer 1 — fast regex (no latency): detects explicit sexual language AND
 *             intimate body-part contact ("le toco un pecho", "le agarré el culo", etc.)
 *  Layer 2 — fast LLM classifier (8 s timeout): catches subtle cases the regex misses.
 * Returns true if the message should be blocked.
 */
async function checkNsfwContent(
  userMessage: string,
  fastProviderId: string | null,
  fastModelId: string | null,
): Promise<boolean> {
  // ── Layer 1: regex ──────────────────────────────────────────────────────────
  const NSFW_REGEX = new RegExp(
    // explicit sexual vocabulary
    '\\b(foll\\w*|viola\\w*|violaci[oó]n|abus[ao]\\w*|acoso\\w*|coger\\w*|penetr\\w*' +
    '|mamar\\w*|masturb\\w*|correrse|polla\\w*|pene\\w*|verga\\w*|vagina\\w*' +
    '|sexo\\s+forz\\w*|relaci[oó]n\\s+sexual' +
    // body-part contact: verb + intimate part
    '|to(?:c|qu)[a-z\\u00e0-\\u00ff\\w]*\\s+(su\\s+|un\\s+|el\\s+|la\\s+|los\\s+|las\\s+)?[a-z\\w]*(pecho|seno|culo|trasero|gl[uú]teo|entrepierna|teta|pez[oó]n|vagina|vulva|pene|verga)[a-z\\w]*' +
    '|agarr[a-z\\u00e0-\\u00ff\\w]*\\s+(su\\s+|un\\s+|el\\s+|la\\s+)?[a-z\\w]*(pecho|seno|culo|teta|trasero|entrepierna)[a-z\\w]*' +
    '|manoseo?\\w*' +
    '|me\\s+voy\\s+a\\s+(coger|follar|violar)' +
    '|voy\\s+a\\s+\\w*(follar|violar|coger)\\w*' +
    '|te\\s+voy\\s+a\\s+\\w*(follar|violar|poseer)\\w*)\\b',
    'i'
  );

  if (NSFW_REGEX.test(userMessage)) {
    console.log('[nsfw-guard] Regex layer blocked message');
    return true;
  }

  // ── Layer 2: fast LLM classifier ───────────────────────────────────────────
  if (!fastProviderId || !fastModelId) return false;

  try {
    const fastProvider = providerRepo.findById(fastProviderId);
    if (!fastProvider?.isEnabled) return false;

    const llm = createProvider(fastProvider);
    const timeout = new Promise<null>((r) => setTimeout(() => r(null), 8_000));
    const result = await Promise.race([
      llm.generate({
        messages: [
          {
            role: 'system',
            content:
              'Eres un clasificador de contenido para un juego de rol.\n' +
              'Responde SOLO con una palabra: SAFE o NSFW.\n\n' +
              'NSFW incluye:\n' +
              '- Contacto físico con partes íntimas sin consentimiento explícito previo\n' +
              '- Solicitudes o insinuaciones sexuales explícitas\n' +
              '- Desnudamiento forzado o tocamientos no deseados\n' +
              '- Violencia sexual o degradación extrema\n\n' +
              'SAFE incluye:\n' +
              '- Romance, coqueteo y afecto no sexual\n' +
              '- Violencia narrativa estándar (peleas, aventura)\n' +
              '- Conversación normal, exploración, magia, etc.',
          },
          { role: 'user', content: `Mensaje del jugador: "${userMessage}"` },
        ],
        model: fastModelId,
        temperature: 0,
        maxTokens: 5,
        stream: false,
      }),
      timeout,
    ]);

    if (!result) {
      console.log('[nsfw-guard] LLM classifier timed out — defaulting to SAFE');
      return false;
    }

    const answer = (result as import('@rpgspeak/shared').GenerateResponse).content.trim().toUpperCase();
    const isNsfw = answer.startsWith('NSFW');
    if (isNsfw) console.log('[nsfw-guard] LLM classifier blocked message');
    return isNsfw;
  } catch (err) {
    console.error('[nsfw-guard] LLM classifier error:', err);
    return false; // fail open — don't block on errors
  }
}

// ─────────────────────────────────────────────────────────────────────────────

export async function generateStream(opts: StreamOptions): Promise<void> {
  const { conversationId, userMessage, branchId = 'main', onToken, onDone, onError } = opts;

  // Mensaje SIN las notas OOC (paréntesis): lo que ven los analizadores de
  // afinidad, memoria y detección de acciones — para que la nota de dirección
  // del jugador no altere relaciones ni conocimiento de los personajes. El
  // mensaje íntegro (con OOC) se guarda y llega a la IA principal como contexto,
  // y la moderación NSFW también lo examina íntegro (no evasible por paréntesis).
  const userMessageForAnalysis = stripOocNotes(userMessage);

  try {
    const conversation = convRepo.findById(conversationId);
    if (!conversation) throw new NotFoundError('Conversation', conversationId);

    const narratorMode = opts.narratorMode ?? false;

    const { character, providerId, modelId } = await resolveCharacterAndProvider(
      conversation,
      opts.characterId,
      opts.overrides,
      narratorMode
    );

    const provider = providerRepo.findById(providerId)!;
    const llm = createProvider(provider);
    const settings = settingsService.getAll();

    // Determine whether to use the fast support LLM for analysis.
    // IMPORTANTE: comprueba también que el provider rápido exista y esté
    // HABILITADO. Antes solo se validaba que estuviera configurado: con
    // fastLlmEnabled=true y el provider deshabilitado, no se inyectaba la
    // instrucción de auto-reporte [AFINIDAD] (porque "el fast LLM se encarga")
    // y el analizador externo tampoco corría (provider disabled) → la afinidad
    // no se actualizaba NUNCA, en silencio. Con este check, ese estado degrada
    // limpiamente a la ruta legacy (el LLM principal emite las etiquetas).
    const fastProvider = settings.fastLlmProviderId
      ? providerRepo.findById(settings.fastLlmProviderId)
      : null;
    const useFastLlm =
      settings.fastLlmEnabled === true &&
      fastProvider?.isEnabled === true &&
      settings.fastLlmModelId != null;
    if (settings.fastLlmEnabled === true && !useFastLlm) {
      console.warn(
        `[fast-llm] Activado en ajustes pero inutilizable (provider ${settings.fastLlmProviderId ?? 'sin configurar'}` +
        `${fastProvider ? (fastProvider.isEnabled ? '' : ' deshabilitado') : ' no existe'}` +
        `${settings.fastLlmModelId ? '' : ', sin modelo'}) — usando auto-reporte de afinidad del LLM principal.`
      );
    }

    // Use ALL linked stories (not filtered by isActive)
    const linkedStories: Story[] = conversation.stories
      .map((s) => storyRepo.findById(s.storyId))
      .filter((s): s is Story => s !== null);

    const isAdventureMode = linkedStories.some((s) => s.adventureMode);

    // Modo "Regreso después de la muerte": activo si alguna historia vinculada
    // lo tiene habilitado. El estado del bucle vive en conversation.metadata.
    const deathModeActive = linkedStories.some((s) => s.deathMode);
    const currentDeathLoop =
      ((conversation.metadata as { deathLoop?: DeathLoopState | null } | null)?.deathLoop) ?? null;

    // Get all group characters
    const groupCharacters: Character[] = conversation.characters
      .map((c) => charRepo.findById(c.characterId))
      .filter((c): c is Character => c !== null);

    // buildContext does [character, ...groupCharacters] internally, so always
    // exclude the primary character from groupChars to avoid duplication.
    const contextGroupChars = groupCharacters.filter((c) => c.id !== character?.id);

    // Save user message
    const userMsg = msgRepo.create({
      conversationId,
      role: 'user',
      content: userMessage,
      branchId,
    });

    // ── NSFW content guard ─────────────────────────────────────────────────────
    if (settings.allowNsfw === false) {
      const isNsfw = await checkNsfwContent(
        userMessage,
        useFastLlm ? (settings.fastLlmProviderId ?? null) : null,
        useFastLlm ? (settings.fastLlmModelId ?? null)   : null,
      );
      if (isNsfw) {
        const blockedText = settings.nsfwBlockedMessage ||
          '*[Moderación: contenido no permitido. Activa "Permitir contenido adulto" en Ajustes → Generación.]*';
        const blockedMsg = msgRepo.create({
          conversationId,
          role: 'assistant',
          content: blockedText,
          characterId: character?.id ?? undefined,
          branchId,
          metadata: { blocked: true, reason: 'nsfw' },
        });
        onToken(blockedText);
        onDone({ messageId: blockedMsg.id, userMessageId: userMsg.id, tokens: 0, tokenBreakdown: { prompt: 0, completion: 0, cached: 0 }, promptMessages: [], affinityUpdates: [], content: blockedText });
        return;
      }
    }
    // ──────────────────────────────────────────────────────────────────────────

    // Build history excluding the just-saved user msg
    const history = msgRepo.findByConversation(conversationId, branchId);
    const historyForContext = history.filter((m) => m.id !== userMsg.id) as Message[];

    const maxMessages = settings.maxContextMessages;
    // Build affinity info for all characters in this conversation
    const allCharsInConv = narratorMode ? groupCharacters : [character, ...contextGroupChars].filter((c): c is Character => c !== null);
    const characterAffinities = allCharsInConv.map((c) => ({
      characterId: c.id,
      name: c.name,
      affinity: conversation.characters.find((l) => l.characterId === c.id)?.affinity ?? 50,
    }));

    // Resolve narration style prompt for the conversation owner
    const convOwner = conversation.userId ? getUserById(conversation.userId) : null;
    const ownerStyle = convOwner?.narrationStyle ?? 'normal';
    const narrationStylePrompt =
      ownerStyle === 'short'  ? (settings.narrationShortPrompt  || undefined) :
      ownerStyle === 'medium' ? (settings.narrationMediumPrompt || undefined) :
      undefined;

    // Eventos de historia ya ocurridos en esta conversación (los pendientes con
    // trigger se inyectan como "trama pendiente" en el footer del contexto)
    const occurredEventIds = eventStatusRepo.findOccurredIds(conversationId);

    const { messages: rawContext, footerCount } = await buildContext({
      character: character ?? groupCharacters[0],
      stories: linkedStories,
      messages: [...historyForContext, { ...userMsg, role: 'user' as const }],
      conversationId,
      globalSystemPrompt: settings.globalSystemPrompt,
      maxMessages,
      summary: conversation.summary,
      blockSummaries: summariesRepo.findBlocks(conversationId),
      characterSummary: !narratorMode && character
        ? ((conversation.metadata as { characterSummaries?: Record<string, string> })
            ?.characterSummaries?.[character.id] ?? null)
        : null,
      groupCharacters: contextGroupChars,
      narratorMode,
      adventureMode: isAdventureMode,
      userDisplayName: opts.userDisplayName,
      characterAffinities,
      affinitySystemPrompt: settings.affinitySystemPrompt,
      responseFormatPrompt: settings.responseFormatPrompt,
      narratorPrompt: settings.narratorPrompt,
      characterCoherencePrompt: settings.characterCoherencePrompt,
      fastLlmEnabled: useFastLlm,
      memoryInjectionPrompt: settings.memoryInjectionPrompt,
      contextIndexInjectionEnabled:  settings.contextIndexInjectionEnabled,
      contextIndexInjectionMaxItems: settings.contextIndexInjectionMaxItems,
      contextIndexInjectionPrompt:   settings.contextIndexInjectionPrompt,
      embeddingEnabled:    settings.embeddingEnabled,
      embeddingProviderId: settings.embeddingProviderId,
      embeddingModel:      settings.embeddingModel,
      narrationStylePrompt,
      currentLocation:     conversation.currentLocation,
      partyState:          (conversation.metadata as { partyState?: PartyState } | null)?.partyState,
      occurredEventIds,
      deathModeActive,
      deathLoop: currentDeathLoop,
    });

    // The global "Ajustes → Contexto" value (settings.defaultContextLength) is the
    // AUTHORITATIVE FLOOR for the context window. A per-character `contextLength`
    // can only ever EXTEND the window beyond the global value, never shrink it
    // below it — otherwise an old/low per-character value (e.g. the legacy 4096
    // default) silently overrides the user's global settings and crowds out real
    // conversation history (see footerCount usage below).
    const activeChar = character ?? groupCharacters[0];
    const globalCtxTokens = settings.defaultContextLength ?? 32768;
    const maxCtxTokens = Math.max(activeChar?.contextLength ?? 0, globalCtxTokens);
    // Always preserve `footerCount` trailing directive blocks (context index, memories,
    // affinity, spatial/object coherence, narration style, last user msg) PLUS at least
    // 6 real conversation turns. Without this, when maxCtxTokens is small (e.g. a
    // character with the 4096-token default), the directive footer alone can fill the
    // whole "preserveRecent" window and trim away ALL real history — the LLM then has
    // no idea what just happened a couple of messages ago.
    const { messages: trimmedMessagesRaw } = trimContext(rawContext, maxCtxTokens, footerCount + 6);
    const trimmedMessages = [...trimmedMessagesRaw];

    // ── Pre-turn behavioral directive injection ────────────────────────────────
    // Two-stage pipeline:
    //   Stage 1 (regex, 0ms): catches obvious physical/sexual actions immediately.
    //   Stage 2 (fast LLM, ~2-8s): when regex finds nothing but there are chars
    //     with affinity < 80, the fast LLM reads the message in full context
    //     (affinities + offense memories + recent history) and decides whether
    //     a directive is needed. Catches subtle cases: emotional questions after
    //     an offense, manipulation attempts, guilt-tripping, etc.
    const hasNonConsentingChars = characterAffinities.some((a) => a.affinity < 80);

    const playerAction = detectPlayerAction(userMessageForAnalysis);
    let turnDirective = buildTurnDirective(playerAction, userMessageForAnalysis, characterAffinities);

    if (!turnDirective && hasNonConsentingChars && useFastLlm) {
      // Fetch recent offense/trauma memories for context
      const allCharsIds = allCharsInConv.map((c) => c.id);
      const recentMemories = allCharsIds.flatMap((id) =>
        memRepo.findByConversation(conversationId, id)
          .filter((m) => (m.type === 'offense' || m.type === 'trauma') && m.importance >= 5)
      );

      // Use the already-built trimmedMessages as recent history (exclude the last user msg)
      const recentHistory = trimmedMessages
        .filter((m) => m.role !== 'system')
        .slice(-8);

      turnDirective = await fastLlmPreAnalysis(
        userMessageForAnalysis,
        characterAffinities,
        recentHistory,
        recentMemories,
        settings.fastLlmProviderId!,
        settings.fastLlmModelId!,
      );
    }

    // ── Corrección de voz narrativa (stateless, un solo turno) ────────────────
    // Si la ÚLTIMA respuesta del asistente narró en primera persona, se inyecta
    // una directiva correctiva. Solo cuando el modo del turno anterior coincide
    // con el actual (corregir la voz del narrador no aplica si ahora habla un
    // personaje, y viceversa).
    let voiceDirective: string | null = null;
    const lastAssistantMsg = [...historyForContext].reverse().find((m) => m.role === 'assistant');
    if (lastAssistantMsg?.content) {
      const wasNarrator = Boolean(lastAssistantMsg.metadata?.narrator);
      if (wasNarrator === narratorMode) {
        const snippet = detectFirstPersonNarration(lastAssistantMsg.content, wasNarrator);
        if (snippet) {
          voiceDirective = buildVoiceCorrectionDirective(snippet, narratorMode);
          console.warn(`[voice-guard] Primera persona en la narración del turno anterior: "${snippet}" — inyectando corrección`);
        }
      }
    }
    // ──────────────────────────────────────────────────────────────────────────

    const injectedDirectives = [voiceDirective, turnDirective].filter((d): d is string => d !== null);
    if (injectedDirectives.length > 0) {
      // Insert as system messages immediately BEFORE the last user message.
      // This is the most salient position — the LLM sees them right before responding.
      const lastUserIdx = trimmedMessages.reduceRight(
        (found, msg, i) => (found === -1 && msg.role === 'user' ? i : found), -1
      );
      for (const directive of injectedDirectives) {
        if (lastUserIdx !== -1) {
          trimmedMessages.splice(lastUserIdx, 0, { role: 'system', content: directive });
        } else {
          trimmedMessages.push({ role: 'system', content: directive });
        }
      }
      if (turnDirective) {
        const source = playerAction ? `regex:${playerAction}` : 'fast-llm';
        console.log(`[pre-turn] Injected behavioral directive (source: ${source})`);
      }
    }
    // ──────────────────────────────────────────────────────────────────────────

    // maxTokens: override > character llmParams > settings global > undefined (provider decides)
    const resolvedMaxTokens =
      opts.overrides?.maxTokens ??
      activeChar?.llmParams?.maxTokens ??
      (settings.maxResponseTokens ?? undefined);

    // contextSize = input budget + 8192 output buffer (Ollama sets num_ctx to this)
    const contextSize = maxCtxTokens + 8192;

    const request: GenerateRequest = {
      messages: trimmedMessages,
      model: modelId,
      contextSize,
      // Tono global manda sobre el valor por personaje; el override puntual (regenerar
      // con otra temp) sigue teniendo prioridad. Modo thinking la ignora (ver provider).
      temperature: opts.overrides?.temperature ?? settings.generationTemperature ?? activeChar?.temperature,
      maxTokens: resolvedMaxTokens,
      topP: activeChar?.llmParams?.topP,
      topK: activeChar?.llmParams?.topK,
      repetitionPenalty: activeChar?.llmParams?.repetitionPenalty,
      stopSequences: activeChar?.llmParams?.stopSequences,
      stream: true,
      disableFallbacks: settings.disableFallbacks,
      reasoning: settings.reasoningEnabled
        ? { enabled: true, effort: settings.reasoningEffort }
        : undefined,
    };

    const assistantMsg = msgRepo.create({
      conversationId,
      role: 'assistant',
      content: '',
      characterId: narratorMode ? undefined : (character?.id ?? undefined),
      branchId,
      metadata: narratorMode
        ? { model: modelId, provider: provider.type, isStreaming: true, narrator: true }
        : { model: modelId, provider: provider.type, isStreaming: true },
    });

    let accumulated = '';
    let thinkAccumulated = '';
    let finalTokens = 0;
    let tokenBreakdown = { prompt: 0, completion: 0, cached: 0 };
    const startTime = Date.now();
    const { signal } = opts;

    // ── <think>…</think> router ───────────────────────────────────────────────
    // Filters reasoning blocks emitted by models like Qwen3 (via <think> tags).
    // Content tokens go to onToken/accumulated; think tokens go to onThinkToken/
    // thinkAccumulated. Runs at the engine level so ALL providers benefit (Ollama,
    // LM Studio, OpenAI-compatible) without each having to implement the filter.
    let inThink = false;
    let thinkBoundary = '';

    const routeToken = (raw: string): void => {
      thinkBoundary += raw;
      while (thinkBoundary.length > 0) {
        const tag = inThink ? '</think>' : '<think>';
        const fullIdx = thinkBoundary.indexOf(tag);
        if (fullIdx !== -1) {
          const before = thinkBoundary.slice(0, fullIdx);
          thinkBoundary = thinkBoundary.slice(fullIdx + tag.length);
          if (!inThink && before) { accumulated += before; onToken(before); }
          if (inThink && before)  { thinkAccumulated += before; opts.onThinkToken?.(before); }
          inThink = !inThink;
          continue;
        }
        // Partial tag at end — hold it back until we know if it's a full tag.
        let holdFrom = thinkBoundary.length;
        for (let i = 0; i < thinkBoundary.length; i++) {
          if (thinkBoundary[i] === '<') {
            const tail = thinkBoundary.slice(i);
            if (tag.startsWith(tail)) { holdFrom = i; break; }
          }
        }
        const safe = thinkBoundary.slice(0, holdFrom);
        if (safe) {
          if (inThink) { thinkAccumulated += safe; opts.onThinkToken?.(safe); }
          else         { accumulated += safe; onToken(safe); }
        }
        thinkBoundary = thinkBoundary.slice(holdFrom);
        break;
      }
    };
    // ─────────────────────────────────────────────────────────────────────────

    const gen = llm.stream(request);
    let iterResult = await gen.next();
    let aborted = false;

    while (!iterResult.done) {
      // Client disconnected or user clicked Stop → break cleanly
      if (signal?.aborted) {
        aborted = true;
        // Cleanly close the generator so provider timers/readers are released
        await gen.return({
          content: accumulated,
          model: modelId,
          tokens: { prompt: 0, completion: 0, total: 0 },
          finishReason: 'stop',
        });
        break;
      }
      routeToken(iterResult.value as string);
      iterResult = await gen.next();
    }

    // Flush any partial tag held in the boundary buffer
    if (thinkBoundary) {
      if (inThink) { thinkAccumulated += thinkBoundary; opts.onThinkToken?.(thinkBoundary); }
      else         { accumulated += thinkBoundary; onToken(thinkBoundary); }
    }

    if (!aborted) {
      const meta = iterResult.value;
      if (meta && typeof meta === 'object' && 'tokens' in meta) {
        const t = (meta as { tokens: { prompt: number; completion: number; total: number; cached?: number } }).tokens;
        finalTokens = t.total;
        tokenBreakdown = { prompt: t.prompt, completion: t.completion, cached: t.cached ?? 0 };
        // Observabilidad del prefix-cache: % de tokens del prompt servidos desde
        // caché en este turno. Permite verificar de un vistazo si un cambio en el
        // orden del contexto rompió (o recuperó) el caché del provider.
        if (tokenBreakdown.prompt > 0) {
          const pct = Math.round((tokenBreakdown.cached / tokenBreakdown.prompt) * 100);
          console.log(
            `[cache] ${narratorMode ? 'narrador' : (character?.name ?? 'personaje')}: ` +
            `${tokenBreakdown.cached}/${tokenBreakdown.prompt} tokens de prompt cacheados (${pct}%)`
          );
        }
      }
    }

    const generationTime = Date.now() - startTime;

    let affinityUpdates: AffinityUpdate[] = [];
    let fastLlmDebug: { prompt: string; response: string } | undefined;
    let cleanContent: string;

    if (useFastLlm && !aborted) {
      console.log(`[fast-llm] Analyzing exchange for conversation ${conversationId} (provider: ${settings.fastLlmProviderId}, model: ${settings.fastLlmModelId})`);
      // Strip any [AFINIDAD:...] tags the main LLM may have emitted — fast LLM handles affinity separately
      cleanContent = accumulated.replace(/\[AFINIDAD:[^\]]+\]/gi, '').trimEnd();
      // Acota el análisis a los personajes que realmente intervienen en este
      // intercambio: el que responde (modo personaje) + cualquiera nombrado en la
      // respuesta o en el mensaje del jugador. Evita que personajes vinculados a
      // la conversación pero AUSENTES de la escena reciban afinidad/memoria.
      const sceneChars = charsInScene(
        allCharsInConv,
        narratorMode ? null : character,
        cleanContent,
        userMessageForAnalysis,
      );
      const sceneAffinities = characterAffinities.filter((a) =>
        sceneChars.some((c) => c.id === a.characterId),
      );
      if (sceneChars.length < allCharsInConv.length) {
        const excluded = allCharsInConv.filter((c) => !sceneChars.some((s) => s.id === c.id)).map((c) => c.name);
        console.log(`[fast-llm] Escena acotada a ${sceneChars.length}/${allCharsInConv.length} personaje(s); excluidos (ausentes): ${excluded.join(', ') || '—'}`);
      }
      const result = await analyzeExchangeAsync(
        conversationId,
        userMessageForAnalysis,
        cleanContent,
        sceneChars,
        sceneAffinities,
        settings.fastLlmProviderId!,
        settings.fastLlmModelId!,
        settings.fastLlmAnalysisPrompt,
      );
      affinityUpdates = result.affinityUpdates;
      fastLlmDebug = settings.fastLlmDebugMode
        ? { prompt: result.rawPrompt, response: result.rawResponse }
        : undefined;
    } else {
      // Legacy behavior: parse [AFINIDAD:...] tags emitted by the main LLM.
      // Regex permisiva y case-insensitive; el nombre capturado se limpia de
      // marcas markdown (**Nombre**, _Nombre_) que algunos modelos añaden y que
      // antes hacían fallar el match exacto — la etiqueta se emitía pero el
      // cambio de afinidad se descartaba en silencio.
      const AFFINITY_RE = /\[AFINIDAD:\s*([^\]:\n]+?)\s*:\s*([+-]?\d+)\s*\]/gi;
      // Los modelos de razonamiento (DeepSeek V4, Qwen3…) casi siempre emiten la
      // etiqueta DENTRO de su razonamiento <think> pese a la instrucción de no
      // hacerlo — el proveedor envuelve `reasoning_content` en <think>…</think> y
      // el router del engine lo deriva a `thinkAccumulated`. Como [AFINIDAD] es un
      // marcador TÉCNICO (no diálogo, se borra antes de mostrarse), lo honramos
      // venga de donde venga: primero la respuesta visible y, si ahí no hay ninguna,
      // como fallback el bloque de razonamiento. Antes se ignoraba la del <think> →
      // con un modelo reasoning la afinidad quedaba CONGELADA para siempre.
      let tagMatches = [...accumulated.matchAll(AFFINITY_RE)];
      let tagSource: 'visible' | 'think' = 'visible';
      if (tagMatches.length === 0 && thinkAccumulated) {
        const thinkMatches = [...thinkAccumulated.matchAll(AFFINITY_RE)];
        if (thinkMatches.length > 0) { tagMatches = thinkMatches; tagSource = 'think'; }
      }
      for (const match of tagMatches) {
        const name  = match[1].replace(/[*_]/g, '').trim();
        const delta = parseInt(match[2], 10);
        // Emparejado tolerante (nombre de pila, artículo omitido, markdown) —
        // ver matchCharacterName en @rpgspeak/shared. Con match exacto estas
        // etiquetas se descartaban en silencio y la afinidad quedaba congelada.
        const found = matchCharacterName(name, allCharsInConv);
        if (found) {
          const currentAffinity = conversation.characters.find((l) => l.characterId === found.id)?.affinity ?? 50;
          const newAffinity = Math.max(1, Math.min(100, currentAffinity + delta));
          convRepo.updateCharacterAffinity(conversationId, found.id, newAffinity);
          affinityUpdates.push({ characterId: found.id, newAffinity, previousAffinity: currentAffinity });
          console.log(`[affinity] ${found.name}: ${currentAffinity} → ${newAffinity} (delta ${delta >= 0 ? '+' : ''}${delta})${tagSource === 'think' ? ' [desde <think>]' : ''}`);
        } else {
          console.warn(`[affinity] Etiqueta [AFINIDAD] con nombre desconocido: "${name}" (personajes válidos: ${allCharsInConv.map((c) => c.name).join(', ')})`);
        }
      }
      if (tagMatches.length === 0) {
        // Sin etiquetas este turno: normal en turnos triviales, sospechoso si se
        // repite en turnos con carga emocional (instrucción ignorada por el modelo).
        console.log('[affinity] Sin etiquetas [AFINIDAD] en la respuesta de este turno');
      } else if (tagSource === 'think') {
        console.log(`[affinity] ${tagMatches.length} etiqueta(s) recuperada(s) del razonamiento <think> (modelo reasoning)`);
      }
      cleanContent = accumulated.replace(/\[AFINIDAD:[^\]]+\]/gi, '').trimEnd();
    }

    // ── Parse [UBICACION:...] / [LOCATION:...] location tags ───────────────────
    // The main LLM emits this tag (per the spatial-coherence directive, in
    // Spanish: [UBICACION:...]) when the scene moves to a new place. We also
    // accept the English [LOCATION:...] form for backward compatibility.
    // We take the LAST occurrence (most authoritative in long responses),
    // persist it and strip all occurrences from the visible content.
    // La clase [OÓ] tolera la tilde: el modelo suele "corregir" la directiva y
    // emitir [UBICACIÓN:...] con tilde (o [Ubicación:...]); sin ella el tag no se
    // capturaba → se colaba al final del mensaje y la ubicación no se actualizaba.
    const LOCATION_RE = /\[(?:UBICACI[OÓ]N|LOCATION):\s*([^\]]+?)\s*\]/gi;
    let locationUpdate: string | null | undefined;
    const locationMatches = [...cleanContent.matchAll(LOCATION_RE)];
    if (locationMatches.length > 0) {
      locationUpdate = locationMatches[locationMatches.length - 1][1].trim();
      convRepo.updateLocation(conversationId, locationUpdate);
      cleanContent = cleanContent.replace(LOCATION_RE, '').trimEnd();
    }
    // ─────────────────────────────────────────────────────────────────────────

    // ── Parse [EVENTO_OCURRIDO:...] story-event tags ──────────────────────────
    // The pending-events footer block instructs the LLM to emit this tag when it
    // narrates one of the script's pending events. We match the title against
    // the linked stories' triggered events, persist the occurred status for this
    // conversation, and strip all occurrences from the visible content.
    const EVENT_DONE_RE = /\[EVENTO_OCURRIDO:\s*([^\]]+?)\s*\]/gi;
    const eventMatches = [...cleanContent.matchAll(EVENT_DONE_RE)];
    if (eventMatches.length > 0) {
      for (const m of eventMatches) {
        const tagTitle = m[1].trim().toLowerCase();
        for (const story of linkedStories) {
          const candidates = story.persistentEvents.filter(
            (e) => e.trigger.trim() && !occurredEventIds.has(e.id),
          );
          // Exact title match first; fall back to containment for minor LLM rephrasing
          const ev =
            candidates.find((e) => e.title.trim().toLowerCase() === tagTitle) ??
            candidates.find((e) => {
              const t = e.title.trim().toLowerCase();
              return t.includes(tagTitle) || tagTitle.includes(t);
            });
          if (ev) {
            eventStatusRepo.markOccurred(conversationId, story.id, ev.id);
            occurredEventIds.add(ev.id);
            console.log(`[story-events] Evento ocurrido en conv ${conversationId}: "${ev.title}"`);
            break;
          }
        }
      }
      cleanContent = cleanContent.replace(EVENT_DONE_RE, '').trimEnd();
    }
    // ─────────────────────────────────────────────────────────────────────────

    // ── Muerte del jugador: [MUERTE_JUGADOR:N:causa] / [MUERTE_SUPERADA] ──────
    // Máquina de estados del bucle (conversation.metadata.deathLoop):
    //   sin bucle + muerte      → 'dead' (count=1) — la UI ofrece rebobinar
    //   'looping' + muerte      → 'dead' (count+1) — vuelve a rebobinar al MISMO ancla
    //   'looping'/'dead' + [MUERTE_SUPERADA] → bucle cerrado (null)
    //   'dead' + generación SIN etiqueta de muerte → revert: la muerte se
    //     regeneró en otra cosa (con ancla → 'looping' con count-1; sin ancla →
    //     null). Guard !aborted: un Stop a media respuesta no debe revertir.
    // Las etiquetas se eliminan SIEMPRE del contenido visible, incluso con el
    // modo desactivado (el modelo puede alucinarlas si conoce el formato).
    const DEATH_RE = /\[MUERTE_JUGADOR:\s*(\d{1,2})\s*(?::\s*([^\]]{1,200}?))?\s*\]/gi;
    const DEATH_OVERCOME_RE = /\[MUERTE_SUPERADA\]/gi;
    const deathMatches = [...cleanContent.matchAll(DEATH_RE)];
    const overcomeFound = DEATH_OVERCOME_RE.test(cleanContent);
    if (deathMatches.length > 0 || overcomeFound) {
      cleanContent = cleanContent.replace(DEATH_RE, '').replace(DEATH_OVERCOME_RE, '').trimEnd();
    }

    // undefined = sin cambios; null = bucle cerrado; objeto = nuevo estado
    let deathLoopUpdate: DeathLoopState | null | undefined = undefined;
    if (deathModeActive && !aborted) {
      if (deathMatches.length > 0) {
        const m = deathMatches[deathMatches.length - 1];
        const depth = Math.min(20, Math.max(1, parseInt(m[1], 10) || 10));
        const cause = m[2]?.trim() || 'causa desconocida';
        if (currentDeathLoop?.status === 'dead') {
          // Muerte regenerada en otra muerte: misma muerte, datos actualizados
          deathLoopUpdate = { ...currentDeathLoop, deathMessageId: assistantMsg.id, rewindDepth: depth, lastDeathCause: cause };
        } else if (currentDeathLoop?.status === 'looping') {
          deathLoopUpdate = {
            ...currentDeathLoop, status: 'dead', deathMessageId: assistantMsg.id,
            rewindDepth: depth, deathCount: currentDeathLoop.deathCount + 1, lastDeathCause: cause,
          };
        } else {
          deathLoopUpdate = { status: 'dead', deathCount: 1, deathMessageId: assistantMsg.id, rewindDepth: depth, lastDeathCause: cause };
        }
        console.log(`[death] Muerte del jugador (nº ${deathLoopUpdate.deathCount}, retroceso ${depth}): ${cause}`);
      } else if (overcomeFound && currentDeathLoop) {
        deathLoopUpdate = null;
        console.log(`[death] ¡Muerte superada tras ${currentDeathLoop.deathCount} intento(s)! Bucle cerrado.`);
      } else if (currentDeathLoop?.status === 'dead') {
        deathLoopUpdate = currentDeathLoop.anchorMessageId
          ? { ...currentDeathLoop, status: 'looping', deathCount: Math.max(1, currentDeathLoop.deathCount - 1), deathMessageId: undefined, rewindDepth: undefined }
          : null;
        console.log('[death] La muerte se regeneró sin etiqueta — estado revertido');
      }
    } else if (deathMatches.length > 0) {
      console.warn('[death] Etiqueta [MUERTE_JUGADOR] emitida con el modo desactivado — ignorada');
    }

    if (deathLoopUpdate !== undefined) {
      // Merge sobre metadata FRESCO para no pisar partyState/characterSummaries
      const freshConv = convRepo.findById(conversationId);
      if (freshConv) {
        convRepo.update(conversationId, { metadata: { ...freshConv.metadata, deathLoop: deathLoopUpdate } });
      }
    }
    // ─────────────────────────────────────────────────────────────────────────

    // Observabilidad del guardián de voz: avisa en cuanto una respuesta narra en
    // primera persona (la directiva correctiva se inyectará en el turno siguiente).
    if (!aborted && cleanContent) {
      const voiceSnippet = detectFirstPersonNarration(cleanContent, narratorMode);
      if (voiceSnippet) {
        console.warn(`[voice-guard] La respuesta recién generada narra en primera persona: "${voiceSnippet}" — se corregirá en el siguiente turno`);
      }
    }

    // Always persist whatever content was generated (full or partial)
    msgRepo.update(assistantMsg.id, {
      content: cleanContent,
      tokens: finalTokens,
      metadata: {
        model: modelId,
        provider: provider.type,
        isStreaming: false,
        generationTime,
        promptTokens: tokenBreakdown.prompt,
        completionTokens: tokenBreakdown.completion,
        cachedTokens: tokenBreakdown.cached,
        ...(aborted ? { aborted: true } : {}),
        ...(narratorMode ? { narrator: true } : {}),
        ...(thinkAccumulated ? { thinkContent: thinkAccumulated } : {}),
        promptMessages: trimmedMessages,
      },
    });

    if (!aborted) {
      convRepo.incrementCounts(conversationId, finalTokens);
      onDone({ messageId: assistantMsg.id, userMessageId: userMsg.id, tokens: finalTokens, tokenBreakdown, promptMessages: trimmedMessages, affinityUpdates, fastLlmDebug, narrator: narratorMode, characterId: assistantMsg.characterId ?? null, content: cleanContent, locationUpdate, thinkContent: thinkAccumulated || undefined, deathLoop: deathLoopUpdate });
      // Fire-and-forget background tasks (non-blocking)
      // En modo personaje con grupo se actualiza además el resumen personal del
      // personaje activo (su "memoria de lo presenciado").
      updateSummaryAsync(
        conversationId, provider, modelId,
        !narratorMode && contextGroupChars.length > 0 ? character : null,
      );
      const updatedConv = convRepo.findById(conversationId);
      if (updatedConv) void autoExtractContextAsync(conversationId, updatedConv.messageCount);
    }

  } catch (err) {
    onError(err instanceof Error ? err : new Error(String(err)));
  }
}

// ─── Fast LLM Analysis ────────────────────────────────────────────────────────

/**
 * Restringe el análisis del fast LLM a los personajes presentes en el intercambio:
 * el que responde (`responder`, null en modo narrador) más cualquiera cuyo nombre
 * aparezca en la respuesta del asistente o en el mensaje del jugador. Así el modelo
 * no recibe siquiera a los personajes ausentes y no puede asignarles afinidad ni
 * memoria.
 */
function charsInScene(
  allChars:          Character[],
  responder:         Character | null,
  assistantResponse: string,
  playerMessage:     string,
): Character[] {
  const haystack = `${assistantResponse}\n${playerMessage}`;
  const isMentioned = (name: string): boolean => {
    const trimmed = name.trim();
    if (!trimmed) return false;
    const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    try {
      // Límite por "no-letra" (soporta acentos) para no casar dentro de otra palabra.
      return new RegExp(`(?<!\\p{L})${escaped}(?!\\p{L})`, 'iu').test(haystack);
    } catch {
      return haystack.toLowerCase().includes(trimmed.toLowerCase());
    }
  };
  return allChars.filter((c) => c.id === responder?.id || isMentioned(c.name));
}

async function analyzeExchangeAsync(
  conversationId: string,
  userMessage: string,
  assistantResponse: string,
  allCharsInConv: Character[],
  characterAffinities: Array<{ characterId: string; name: string; affinity: number }>,
  fastProviderId: string,
  fastModelId: string,
  promptTemplate: string,
): Promise<{ affinityUpdates: AffinityUpdate[]; rawResponse: string; rawPrompt: string }> {
  try {
    const fastProvider = providerRepo.findById(fastProviderId);
    if (!fastProvider || !fastProvider.isEnabled) {
      console.warn(`[fast-llm] Provider ${fastProviderId} not found or disabled`);
      return { affinityUpdates: [], rawResponse: '', rawPrompt: '' };
    }

    const llm = createProvider(fastProvider);

    const charLines = characterAffinities
      .map(({ name, affinity }) => `- ${name} (afinidad: ${affinity}/100)`)
      .join('\n');

    // Substitute placeholders in the template
    const analysisPrompt = promptTemplate
      .replace('{{PERSONAJES}}', charLines)
      .replace('{{MENSAJE_JUGADOR}}', userMessage)
      .replace('{{RESPUESTA}}', assistantResponse);

    const request: GenerateRequest = {
      messages: [
        {
          role: 'system',
          content: 'Eres un analizador de eventos de juego de rol. Responde solo con las etiquetas indicadas o la palabra NINGUNO.',
        },
        { role: 'user', content: analysisPrompt },
      ],
      model: fastModelId,
      temperature: 0.1,
      maxTokens: 512,
      stream: false,
      disableFallbacks: settingsService.getAll().disableFallbacks,
    };

    // 60-second timeout — non-streaming local LLMs need time to generate the full reply
    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 60_000));
    const result = await Promise.race([llm.generate(request), timeout]);
    if (!result) {
      console.warn('[fast-llm] Request timed out after 60s');
      return { affinityUpdates: [], rawResponse: '(timeout)', rawPrompt: analysisPrompt };
    }

    const responseText = (result as import('@rpgspeak/shared').GenerateResponse).content;
    console.log(`[fast-llm] Response: ${responseText.slice(0, 200)}${responseText.length > 200 ? '…' : ''}`);

    // Parse memory entries
    const MEMORY_RE = /\[MEMORIA:([^:]+):([^:]+):(\d+)\]([\s\S]+?)\[\/MEMORIA\]/g;
    const TYPE_MAP: Record<string, MemoryEntry['type']> = {
      evento:      'event',
      hecho:       'fact',
      relacion:    'relationship',
      preferencia: 'preference',
      ofensa:      'offense',
      trauma:      'trauma',
    };
    for (const match of [...responseText.matchAll(MEMORY_RE)]) {
      const charName   = match[1].trim();
      const typeRaw    = match[2].trim().toLowerCase();
      const importance = parseInt(match[3], 10);
      const content    = match[4].trim();
      if (importance < 8) continue; // hard floor — below 8 is noise; the prompt eliminates 7 but this is the server backstop
      const found = allCharsInConv.find((c) => c.name.toLowerCase() === charName.toLowerCase());
      if (!found) continue;
      memRepo.create({
        conversationId,
        characterId: found.id,
        type: TYPE_MAP[typeRaw] ?? 'event',
        content,
        importance,
        isActive: true,
      });
    }

    // Parse affinity updates
    // Safety detection: explicit sexual / vexatious player intent
    const SEXUAL_VEXATIOUS_RE =
      /\b(foll\w*|viola\w*|violaci[oó]n|abus[ao]\w*|acoso\w*|coger\w*|penetr\w*|chup\w*\s+mi|mamar\w*|masturb\w*|correrse|culo\w*|polla\w*|pene\w*|verga\w*|tetas?|desnud\w*|sexo\s+forz\w*|me\s+voy\s+a\s+(coger|follar|violar)|voy\s+a\s+\w*(follar|violar|coger)\w*|te\s+voy\s+a\s+\w*(follar|violar|poseer)\w*)\b/i;
    const playerHasSexualOrAbusiveIntent = SEXUAL_VEXATIOUS_RE.test(userMessage);

    const AFFINITY_RE = /\[AFINIDAD:\s*([^\]:\n]+?)\s*:\s*([+-]?\d+)\s*\]/gi;
    const affinityUpdates: AffinityUpdate[] = [];
    for (const match of [...responseText.matchAll(AFFINITY_RE)]) {
      const name  = match[1].replace(/[*_]/g, '').trim();
      let delta   = parseInt(match[2], 10);
      const found = allCharsInConv.find((c) => c.name.toLowerCase() === name.toLowerCase());
      if (!found) continue;

      // Hard floor: ignore micro-deltas — they are noise, not meaningful relationship shifts.
      // The prompt already asks for ≥8, but this is a server-side backstop.
      if (Math.abs(delta) < 8) {
        console.log(`[fast-llm] Skipping micro-delta ${delta} for "${found.name}" (below ±8 threshold)`);
        continue;
      }

      const current = characterAffinities.find((a) => a.characterId === found.id)?.affinity ?? 50;

      // ─── Server-side safety guardrail ────────────────────────────────────────
      if (playerHasSexualOrAbusiveIntent && current < 80 && delta > 0) {
        console.warn(
          `[fast-llm] ⚠ Safety override: sexual/abusive intent detected, affinity ${current}/100 < 80` +
          ` → flipping +${delta} to -${Math.abs(delta) + 5} for "${found.name}"`
        );
        delta = -(Math.abs(delta) + 5);
      }
      // ─────────────────────────────────────────────────────────────────────────

      const newAffinity = Math.max(1, Math.min(100, current + delta));
      convRepo.updateCharacterAffinity(conversationId, found.id, newAffinity);
      affinityUpdates.push({ characterId: found.id, newAffinity, previousAffinity: current });
    }

    return { affinityUpdates, rawResponse: responseText, rawPrompt: analysisPrompt };
  } catch (err) {
    console.error('[fast-llm] analyzeExchangeAsync error:', err);
    return { affinityUpdates: [], rawResponse: `(error: ${err})`, rawPrompt: '' };
  }
}

// ─── Resúmenes por bloques ────────────────────────────────────────────────────
//
// Sustituye al antiguo resumen rodante global (que re-resumía un resumen cada 6
// mensajes — "teléfono estropeado": los eventos antiguos se degradaban en cada
// iteración, y el grueso del presupuesto se gastaba en re-contar lo que el modelo
// ya tenía literal en el historial).
//
// Ahora la historia se trocea en bloques de `summaryBlockSize` mensajes. Cada
// bloque completado se resume UNA sola vez a partir de los mensajes crudos y
// queda inmutable en conversation_summaries (kind='block'). buildContext inyecta
// solo los bloques anteriores a la ventana de historial vivo — fidelidad estable
// para el pasado lejano, cero redundancia con el historial reciente.

// Etiqueta cada turno con su hablante REAL (nombre del personaje, Narrador o
// Jugador). El etiquetado genérico ("Personaje" para todo turno assistant)
// hacía que en conversaciones de grupo el resumen no supiera quién hizo o dijo
// qué — y ese resumen es lo que el LLM ve como "Historia hasta ahora",
// propagando la confusión de identidades a toda la conversación.
function labelSpeakers(msgs: Message[]): string {
  const nameCache = new Map<string, string>();
  return msgs
    .map((m) => {
      // Las notas OOC del jugador (paréntesis) NO entran en los resúmenes: no
      // deben cristalizar como hechos que los personajes acaben "conociendo".
      const content = m.role === 'user' ? stripOocNotes(m.content) : m.content;
      if (!content.trim()) return null; // turno que era SOLO nota OOC → se omite

      let speaker = 'Jugador';
      if (m.role !== 'user') {
        if (m.metadata?.narrator || !m.characterId) {
          speaker = 'Narrador';
        } else {
          const cached = nameCache.get(m.characterId);
          if (cached) speaker = cached;
          else {
            speaker = charRepo.findById(m.characterId)?.name ?? 'Personaje';
            nameCache.set(m.characterId, speaker);
          }
        }
      }
      return `${speaker}: ${content}`;
    })
    .filter((line): line is string => line !== null)
    .join('\n\n');
}

async function generateBlockSummaries(
  conversationId: string,
  provider: NonNullable<ReturnType<ProviderRepository['findById']>>,
  modelId: string,
): Promise<void> {
  const conv = convRepo.findById(conversationId);
  if (!conv) return;

  const settings  = settingsService.getAll();
  const blockSize = Math.max(10, settings.summaryBlockSize ?? 40);
  const maxFrases = settings.summaryMaxLength ?? 5;

  // El mismo orden de mensajes que ve buildContext (rama principal) — los índices
  // de los bloques deben coincidir con la ventana de historial que calcula.
  const allMessages     = msgRepo.findByConversation(conversationId);
  const completedBlocks = Math.floor(allMessages.length / blockSize);
  if (completedBlocks === 0) return;

  const existing = summariesRepo.findBlocks(conversationId);
  const covered  = new Set(existing.map((b) => b.messageIndexFrom));
  const llm      = createProvider(provider);

  // Bucle de puesta al día: normalmente genera 0 o 1 bloques por turno, pero
  // recupera atrasos (conversaciones anteriores al sistema, fallos previos del
  // LLM, o un cambio de summaryBlockSize).
  let prevContent = '';
  for (let k = 0; k < completedBlocks; k++) {
    const from = k * blockSize;
    const to   = from + blockSize - 1;
    if (covered.has(from)) {
      prevContent = existing.find((b) => b.messageIndexFrom === from)?.content ?? prevContent;
      continue;
    }

    const blockMsgs = allMessages.slice(from, to + 1).filter((m) => m.role !== 'system');
    if (blockMsgs.length === 0) continue;
    const messagesText = labelSpeakers(blockMsgs);

    const prompt =
      `Eres el cronista de una historia colaborativa de rol. Resume el siguiente fragmento ` +
      `(mensajes ${from + 1}–${to + 1} de la historia).\n\n` +
      (prevContent
        ? `CONTEXTO — lo ocurrido justo antes (NO lo re-resumas, es solo referencia):\n---\n${prevContent}\n---\n\n`
        : '') +
      `FRAGMENTO A RESUMIR:\n---\n${messagesText}\n---\n\n` +
      `Escribe un resumen SOLO del fragmento. Debe ser:\n` +
      `- Objetivo y fiel a lo narrado\n` +
      `- Conserva siempre: nombres propios, lugares, objetos relevantes, promesas, decisiones y heridas o cambios de estado\n` +
      `- Máximo ${maxFrases} frases, en pasado narrativo\n` +
      `- Sin explicaciones ni frases introductorias\n\n` +
      `Responde SOLO con el texto del resumen.`;

    const response = await llm.generate({
      messages: [
        { role: 'system', content: 'Eres un cronista que resume fragmentos de una historia colaborativa de rol.' },
        { role: 'user', content: prompt },
      ],
      model: modelId,
      temperature: 0.3,
      stream: false,
      disableFallbacks: settings.disableFallbacks,
    } satisfies GenerateRequest);

    const content = response.content.trim();
    if (!content) return; // el LLM falló: se reintentará en el próximo turno

    summariesRepo.create({ conversationId, content, messageIndexFrom: from, messageIndexTo: to, kind: 'block' });
    console.log(`[summary] Bloque ${from + 1}–${to + 1} resumido para conv ${conversationId}`);
    prevContent = content;
  }
}

// ─── Resumen personal por personaje ───────────────────────────────────────────
//
// La "memoria personal" del personaje: resumen rodante generado SOLO con los
// segmentos que el personaje presenció (filterWitnessedMessages — el mismo
// filtro que aplica buildContext al historial). En modo personaje con grupo,
// buildContext inyecta este resumen en lugar del global del cronista, que
// revelaría escenas privadas del jugador con otros personajes.
//
// Se persiste en conversation.metadata.characterSummaries[charId] (merge con el
// metadata existente para no pisar partyState u otros campos).

async function generateCharacterSummary(
  conversationId: string,
  provider: NonNullable<ReturnType<ProviderRepository['findById']>>,
  modelId: string,
  character: Character,
): Promise<void> {
  const conv = convRepo.findById(conversationId);
  if (!conv) return;

  const allMessages = msgRepo.findByConversation(conversationId) as Message[];
  // Elenco completo → mismo agrupado de escenas narradas que en buildContext.
  const allChars = conv.characters
    .map((c) => charRepo.findById(c.characterId))
    .filter((c): c is Character => c !== null);
  const witnessed   = filterWitnessedMessages(allMessages, character, allChars)
    .filter((m) => m.role !== 'system'); // fuera elipsis y mensajes de sistema
  const recentMessages = witnessed.slice(-6);
  if (recentMessages.length < 2) return;

  const settings  = settingsService.getAll();
  const maxFrases = settings.summaryMaxLength ?? 5;
  // Ámbito personal (una sola relación) → presupuesto menor que el global (×3).
  const maxFrasesTotal = maxFrases * 2;

  const existing = (conv.metadata as { characterSummaries?: Record<string, string> })
    ?.characterSummaries ?? {};
  const previousSummary = existing[character.id]?.trim() ?? '';
  const messagesText = labelSpeakers(recentMessages);

  const prompt = previousSummary
    ? `Eres la memoria personal de ${character.name} en una historia de rol. Mantienes un resumen acumulado de TODO lo que ${character.name} ha vivido y presenciado en primera persona — y SOLO eso.

RESUMEN ACUMULADO DE SU EXPERIENCIA:
---
${previousSummary}
---

NUEVOS INTERCAMBIOS QUE ${character.name.toUpperCase()} HA PRESENCIADO:
---
${messagesText}
---

Escribe la versión ACTUALIZADA del resumen, integrando los nuevos intercambios:
- Solo lo que ${character.name} vivió o presenció — nada de otras escenas
- Conserva: nombres, lugares, objetos, promesas, decisiones y el estado de su relación con el jugador
- Comprime lo antiguo y detalla lo reciente
- Máximo ${maxFrasesTotal} frases, en pasado narrativo
- Sin explicaciones ni frases introductorias

Responde SOLO con el texto del resumen actualizado.`
    : `Eres la memoria personal de ${character.name} en una historia de rol. Revisa estos intercambios que ${character.name} ha vivido:

---
${messagesText}
---

Escribe un resumen de lo que ${character.name} ha vivido. Debe ser:
- Fiel a lo narrado y limitado a su experiencia directa
- Conciso: máximo ${maxFrases} frases
- En pasado narrativo
- Sin explicaciones ni frases introductorias

Responde SOLO con el texto del resumen.`;

  const llm = createProvider(provider);
  const response = await llm.generate({
    messages: [
      { role: 'system', content: `Eres la memoria personal del personaje ${character.name}: registras solo lo que él ha vivido.` },
      { role: 'user', content: prompt },
    ],
    model: modelId,
    temperature: 0.3,
    stream: false,
    disableFallbacks: settings.disableFallbacks,
  });
  const newSummary = response.content.trim();
  if (!newSummary) return;

  // Merge sobre el metadata FRESCO (releído) para minimizar la ventana de pisado
  // con otras escrituras de metadata (p. ej. partyState desde el BattleModal).
  const fresh = convRepo.findById(conversationId);
  if (!fresh) return;
  const freshSummaries = (fresh.metadata as { characterSummaries?: Record<string, string> })
    ?.characterSummaries ?? {};
  convRepo.update(conversationId, {
    metadata: {
      ...fresh.metadata,
      characterSummaries: { ...freshSummaries, [character.id]: newSummary },
    },
  });
  console.log(`[summary] Resumen personal actualizado para ${character.name} (${witnessed.length} msgs presenciados)`);
}

async function updateSummaryAsync(
  conversationId: string,
  provider: ReturnType<ProviderRepository['findById']>,
  modelId: string,
  /** Personaje activo del turno (solo modo personaje con grupo) — dispara además
   *  la actualización de su resumen personal. */
  characterForPersonalSummary?: Character | null,
): Promise<void> {
  if (!provider) return;
  try {
    const SUMMARY_EVERY_N = 6; // cadencia del resumen personal (rodante)
    const conv = convRepo.findById(conversationId);
    if (!conv) return;

    // Los resúmenes usan SIEMPRE el provider principal: son la memoria a largo
    // plazo de la historia y su calidad importa. El fast LLM solo está presente
    // en pruebas locales — en producción (VPS) no existe, y desviar los resúmenes
    // a él haría que la calidad de la crónica dependiera del entorno.

    // Bloques globales: la comprobación es barata (no-op salvo que un bloque se
    // haya completado), así que se ejecuta en todos los turnos.
    await generateBlockSummaries(conversationId, provider, modelId);

    // El resumen personal por personaje sigue siendo rodante (ventana de 6 msgs).
    if (characterForPersonalSummary && conv.messageCount % SUMMARY_EVERY_N === 0) {
      await generateCharacterSummary(conversationId, provider, modelId, characterForPersonalSummary);
    }
  } catch (err) {
    // Summary update is non-critical — log and continue
    console.error('[summary] Error updating summary:', err);
  }
}

export async function triggerSummaryUpdate(conversationId: string): Promise<Conversation> {
  const conv = convRepo.findById(conversationId);
  if (!conv) throw new NotFoundError('Conversation', conversationId);

  const settings = settingsService.getAll();
  const firstCharId = conv.characters[0]?.characterId;
  const firstChar = firstCharId ? charRepo.findById(firstCharId) : null;

  const providerId = firstChar?.providerId ?? settings.defaultProviderId ?? 'default-ollama';
  const provider = providerRepo.findById(providerId);
  if (!provider || !provider.isEnabled) {
    return conv;
  }

  const modelId = firstChar?.modelId ?? provider.defaultModel ?? settings.defaultModelId;
  if (!modelId) return conv;

  try {
    await generateBlockSummaries(conversationId, provider, modelId);
  } catch (err) {
    console.error('[summary] Error in triggerSummaryUpdate:', err);
  }

  return convRepo.findById(conversationId)!;
}

// ─── Regreso después de la muerte ─────────────────────────────────────────────
//
// performDeathRewind ejecuta el "regreso a un punto del pasado" que la UI
// ofrece cuando el jugador muere (deathLoop.status === 'dead'):
//   1. Determina el ANCLA: en la primera muerte, N mensajes antes del mensaje
//      de muerte (N = rewindDepth de la IA, 1-20); en muertes posteriores del
//      mismo bucle, el MISMO ancla anterior (se repite el mismo tramo).
//   2. Genera el "hilo fatal" (solo primera muerte): resumen LLM de la
//      secuencia que llevó a la muerte, con fallback mecánico si el LLM falla.
//   3. Borra todos los mensajes posteriores al ancla.
//   4. Restaura el resumen global al último snapshot ANTERIOR al ancla (el
//      resumen rodante puede contener hechos de la línea temporal borrada) y
//      elimina los resúmenes personales por personaje (se regeneran solos).
//   5. Deja el bucle en 'looping' → buildContext inyecta la directiva de
//      repetición hasta que la IA emita [MUERTE_SUPERADA] (o el usuario lo
//      cierre manualmente con clearDeathLoop).

async function summarizeFatalThread(
  segment: Message[],
  conv: Conversation,
): Promise<string> {
  // Fallback mecánico: extracto etiquetado por hablante (siempre disponible)
  const excerpt = segment
    .slice(-16)
    .map((m) => {
      const label = m.role === 'user' ? 'Jugador' : (m.metadata?.narrator || !m.characterId
        ? 'Narrador'
        : (charRepo.findById(m.characterId)?.name ?? 'Personaje'));
      return `${label}: ${m.content.slice(0, 180)}${m.content.length > 180 ? '…' : ''}`;
    })
    .join('\n');

  // Intento LLM (mismo esquema de resolución que el resumen rodante)
  try {
    const settings = settingsService.getAll();
    const firstCharId = conv.characters[0]?.characterId;
    const firstChar = firstCharId ? charRepo.findById(firstCharId) : null;
    const providerId = settings.defaultProviderId ?? firstChar?.providerId ?? 'default-ollama';
    const provider = providerRepo.findById(providerId);
    if (!provider?.isEnabled) return excerpt;
    const modelId = settings.defaultModelId ?? firstChar?.modelId ?? provider.defaultModel;
    if (!modelId) return excerpt;

    const llm = createProvider(provider);
    const prompt =
      `Eres el director de un bucle temporal en una historia de rol. El jugador ha muerto y la historia va a rebobinarse. ` +
      `Resume la SECUENCIA FATAL para que pueda repetirse fielmente:\n\n---\n${labelSpeakers(segment)}\n---\n\n` +
      `Escribe 5-8 frases en pasado narrativo cubriendo: la situación de partida, el lugar o lugares, los personajes ` +
      `y amenazas presentes, las decisiones del jugador, y el momento exacto de la muerte con su causa. ` +
      `Sin explicaciones ni introducciones — responde SOLO con el resumen.`;

    const timeout = new Promise<null>((r) => setTimeout(() => r(null), 30_000));
    const result = await Promise.race([
      llm.generate({
        messages: [
          { role: 'system', content: 'Eres un cronista que resume secuencias narrativas con precisión.' },
          { role: 'user', content: prompt },
        ],
        model: modelId,
        temperature: 0.3,
        maxTokens: 500,
        stream: false,
        disableFallbacks: settings.disableFallbacks,
      }),
      timeout,
    ]);
    const text = (result as import('@rpgspeak/shared').GenerateResponse | null)?.content?.trim();
    return text || excerpt;
  } catch (err) {
    console.error('[death] Error resumiendo el hilo fatal, usando extracto:', err);
    return excerpt;
  }
}

export async function performDeathRewind(
  conversationId: string,
): Promise<{ conversation: Conversation; deleted: number }> {
  const conv = convRepo.findById(conversationId);
  if (!conv) throw new NotFoundError('Conversation', conversationId);

  const loop = (conv.metadata as { deathLoop?: DeathLoopState | null })?.deathLoop ?? null;
  if (!loop || loop.status !== 'dead') {
    throw new ValidationError('No hay ninguna muerte pendiente de rebobinar en esta conversación.');
  }

  const allMessages = msgRepo.findByConversation(conversationId); // rama main
  if (allMessages.length === 0) throw new ValidationError('La conversación no tiene mensajes.');

  // Mensaje de la muerte: por id; si fue borrado/editado, la última respuesta
  const deathIdxById = loop.deathMessageId
    ? allMessages.findIndex((m) => m.id === loop.deathMessageId)
    : -1;
  const deathIdx = deathIdxById !== -1
    ? deathIdxById
    : allMessages.map((m) => m.role).lastIndexOf('assistant');
  if (deathIdx <= 0) {
    // Muerte en el primer mensaje (o sin mensajes assistant): no hay pasado.
    convRepo.update(conversationId, { metadata: { ...conv.metadata, deathLoop: null } });
    throw new ValidationError('No hay pasado al que regresar — el bucle se ha cancelado.');
  }

  // Ancla: la del bucle si sigue existiendo antes de la muerte; si no, N atrás
  const anchorIdxFromLoop = loop.anchorMessageId
    ? allMessages.findIndex((m) => m.id === loop.anchorMessageId)
    : -1;
  const depth = Math.min(20, Math.max(1, loop.rewindDepth ?? 10));
  const anchorIdx = (anchorIdxFromLoop !== -1 && anchorIdxFromLoop < deathIdx)
    ? anchorIdxFromLoop
    : Math.max(0, deathIdx - depth);
  const anchor = allMessages[anchorIdx];

  // Hilo fatal: solo se genera en la primera muerte del bucle (el tramo es el mismo)
  const threadSummary = loop.threadSummary?.trim()
    ? loop.threadSummary
    : await summarizeFatalThread(allMessages.slice(anchorIdx + 1, deathIdx + 1), conv);

  // Borra la línea temporal condenada (todo lo posterior al ancla)
  const deleted = msgRepo.deleteAfter(anchor.id);

  // Resúmenes por bloques: los que se extienden más allá del ancla narran la
  // línea temporal borrada — fuera. Los anteriores siguen válidos (inmutables).
  summariesRepo.deleteBlocksBeyond(conversationId, anchorIdx);
  // Resumen legacy (conversations.summary, fallback para conversaciones sin
  // bloques): restaurar al último snapshot manual/rodante anterior al ancla.
  const snapshots = summariesRepo.findByConversation(conversationId); // desc por fecha
  const snapshot = snapshots.find((s) => s.kind !== 'block' && s.messageIndexTo <= anchorIdx);
  convRepo.update(conversationId, { summary: snapshot?.content ?? null });

  // Metadata: bucle a 'looping' + fuera resúmenes personales (contienen la
  // línea borrada; se regeneran solos con el juego).
  const fresh = convRepo.findById(conversationId)!;
  const newMeta = { ...fresh.metadata } as Record<string, unknown>;
  delete newMeta.characterSummaries;
  newMeta.deathLoop = {
    status: 'looping',
    deathCount: loop.deathCount,
    anchorMessageId: anchor.id,
    threadSummary,
    lastDeathCause: loop.lastDeathCause,
  } satisfies DeathLoopState;
  convRepo.update(conversationId, { metadata: newMeta });

  console.log(
    `[death] Rebobinado a "${anchor.content.slice(0, 50)}…" — ${deleted} mensajes eliminados ` +
    `(muerte nº ${loop.deathCount}, ancla ${anchor.id})`
  );

  return { conversation: convRepo.findById(conversationId)!, deleted };
}

/** Cierra el bucle de muerte manualmente (el usuario lo da por superado o lo
 *  abandona). También limpia un estado 'dead' huérfano. */
export function clearDeathLoop(conversationId: string): Conversation {
  const conv = convRepo.findById(conversationId);
  if (!conv) throw new NotFoundError('Conversation', conversationId);
  convRepo.update(conversationId, { metadata: { ...conv.metadata, deathLoop: null } });
  console.log(`[death] Bucle de muerte cerrado manualmente en conv ${conversationId}`);
  return convRepo.findById(conversationId)!;
}
