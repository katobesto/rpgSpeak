import type { GenerateRequest, Character, Story, Message, Conversation, MemoryEntry, PartyState, DeathLoopState, WorldState, StoryCalendar, SceneDirectorState, CharacterSceneState, NpcSceneState, RpgStats } from '@rpgspeak/shared';
import { matchCharacterName } from '@rpgspeak/shared';
import {
  computeClock, formatHeader, normalizeWorldState, parseTimeAdvance, parseSceneTag,
  applySceneTime, currentMinuteOfDay, DEFAULT_ADVANCE_MINUTES,
} from '../world/calendar.js';
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
import { autoExtractContextAsync, hasPendingContextExtraction } from '../context/context-extractor.js';
import { SummariesRepository } from '../../modules/summaries/summaries.repository.js';
import { EventStatusRepository } from '../../modules/stories/event-status.repository.js';
import { ThreadRepository } from '../../modules/threads/thread.repository.js';
import { stripOocNotes } from './ooc.js';
import { DICE_ROLL_RE, resolveRollSheet, resolveRollModifier, rollDice, type DiceRollResult } from './dice.js';
import { recordBgUsage, readBgUsage, diffBgUsage } from './bg-usage.js';

const providerRepo   = new ProviderRepository();
const charRepo       = new CharacterRepository();
const storyRepo      = new StoryRepository();
const msgRepo        = new MessageRepository();
const convRepo       = new ConversationRepository();
const settingsService = new SettingsService();
const memRepo        = new MemoryRepository();
const summariesRepo  = new SummariesRepository();
const eventStatusRepo = new EventStatusRepository();
const threadRepo     = new ThreadRepository();

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

/** Un paso del enriquecimiento en segundo plano tras generar la respuesta
 *  (director de escena, resúmenes, anclaje del mundo…). `index` es 1-based. */
export interface EnrichStepInfo {
  index: number;
  total: number;
  label: string;
}

export interface StreamOptions extends GenerateOptions {
  signal?: AbortSignal;
  onToken: (token: string) => void;
  /** Called for each token inside a &lt;think&gt;...&lt;/think&gt; block (reasoning models). */
  onThinkToken?: (token: string) => void;
  onDone: (response: { messageId: string; userMessageId: string; tokens: number; tokenBreakdown: { prompt: number; completion: number; cached: number }; promptMessages: import('@rpgspeak/shared').ChatMessage[]; affinityUpdates: AffinityUpdate[]; fastLlmDebug?: { prompt: string; response: string }; narrator?: boolean; characterId?: string | null; content?: string; locationUpdate?: string | null; thinkContent?: string; deathLoop?: DeathLoopState | null; diceRoll?: DiceRollResult }) => void;
  onError: (error: Error) => void;
  /** Se llama justo ANTES de ejecutar cada paso del enriquecimiento de fondo
   *  (las ráfagas de llamadas al LLM que mantienen el estado del mundo, el
   *  director de escena y los resúmenes). El mensaje ya está persistido y
   *  visible en este punto (onDone ya se llamó) — esto es progreso informativo,
   *  no bloquea el chat. Solo se llama para pasos que de verdad van a hacer
   *  trabajo; una respuesta sin ninguno debido no dispara esta señal. */
  onEnrichStep?: (step: EnrichStepInfo) => void;
  /** Se llama una vez, al terminar la pasada de enriquecimiento (incluso si no
   *  hubo ningún paso pendiente), para que la UI pueda ocultar el indicador.
   *  `bgTokens` es el coste de fondo de ESTE turno (moderación, pre-análisis,
   *  enriquecimiento) — solo presente cuando hubo alguna llamada. */
  onEnrichDone?: (info?: { bgTokens?: import('@rpgspeak/shared').BackgroundTokenUsage }) => void;
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
  conversationId?: string,
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

    if (conversationId) {
      recordBgUsage(conversationId, 'pre-analisis', (result as import('@rpgspeak/shared').GenerateResponse).tokens);
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

// ─── Cabecera ambiental: normalización ────────────────────────────────────────
//
// Detecta una cabecera de pipes al principio de la respuesta. Es deliberadamente
// laxa en lo que RECONOCE (el modelo la deforma: se deja el pipe final, mete
// negritas, la envuelve en cursivas) y estricta en lo que ESCRIBE — siempre la
// canónica. Reconocer de más es lo correcto aquí: una cabecera deforme detectada
// se sustituye, mientras que una no detectada se duplicaría con la canónica.

/** Una línea es "cabecera" si empieza por | y tiene al menos 4 separadores:
 *  suficiente para no confundirla con una tabla markdown de 2 columnas ni con
 *  prosa que empiece por un pipe suelto. */
const HEADER_LINE_RE = /^\s*[*_]{0,2}\s*\|(?:[^|\n]*\|){4,}\s*[*_]{0,2}\s*$/;

export function normalizeWorldHeader(content: string, canonical: string | null | undefined): string {
  const header = canonical?.trim() ?? '';

  const lines = content.split('\n');
  const firstIdx = lines.findIndex((l) => l.trim() !== '');
  if (firstIdx === -1) return content;

  // Sin cabecera canónica (escena aún sin anclar) se ELIMINA la que el modelo
  // haya inventado: no hay nada contra lo que validarla, y una cabecera que
  // cambia de hora y lugar a capricho entre turnos es justo la incoherencia
  // que este mecanismo existe para evitar.
  if (!header) {
    if (HEADER_LINE_RE.test(lines[firstIdx])) {
      console.warn(`[world] Cabecera inventada sin escena anclada — eliminada: "${lines[firstIdx].trim().slice(0, 80)}"`);
      return lines.slice(firstIdx + 1).join('\n').trimStart();
    }
    return content;
  }

  if (HEADER_LINE_RE.test(lines[firstIdx])) {
    if (lines[firstIdx].trim() !== header) {
      console.warn(`[world] Cabecera divergente sustituida por la canónica: "${lines[firstIdx].trim().slice(0, 90)}"`);
      lines[firstIdx] = header;
    }
    // El slice va también en el caso exacto: el modelo a veces abre con líneas
    // en blanco y la cabecera debe quedar como PRIMERA línea del mensaje.
    return lines.slice(firstIdx).join('\n');
  }

  // No la emitió: se antepone. Línea en blanco entre medias para que `marked`
  // no funda la cabecera con el primer párrafo en un solo <p>.
  console.warn('[world] Respuesta sin cabecera ambiental — anteponiendo la canónica');
  return `${header}\n\n${content.trimStart()}`;
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
  conversationId?: string,
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

    if (conversationId) {
      recordBgUsage(conversationId, 'moderacion', (result as import('@rpgspeak/shared').GenerateResponse).tokens);
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
  const { conversationId, userMessage, branchId = 'main', onToken, onDone, onError, onEnrichStep, onEnrichDone } = opts;

  // Mensaje SIN las notas OOC (paréntesis): lo que ven los analizadores de
  // afinidad, memoria y detección de acciones — para que la nota de dirección
  // del jugador no altere relaciones ni conocimiento de los personajes. El
  // mensaje íntegro (con OOC) se guarda y llega a la IA principal como contexto,
  // y la moderación NSFW también lo examina íntegro (no evasible por paréntesis).
  const userMessageForAnalysis = stripOocNotes(userMessage);

  try {
    const conversation = convRepo.findById(conversationId);
    if (!conversation) throw new NotFoundError('Conversation', conversationId);

    // Instantánea del acumulado de tokens de fondo ANTES de cualquier llamada
    // del turno (moderación, pre-análisis, enriquecimiento...). Al final del
    // turno la diferencia es el coste de fondo de ESTE turno, que se adjunta
    // al mensaje y viaja en el evento enrich_done.
    const bgUsageBefore = readBgUsage(conversation.metadata);

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
        conversationId,
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

    // Ficha del jugador — se reutiliza más abajo para resolver el modificador
    // real de las tiradas de dados ([TIRADA:...]).
    const playerSheet = (conversation.metadata as { playerSheet?: RpgStats } | null)?.playerSheet ?? null;

    // ── Estado del mundo (cabecera ambiental) ─────────────────────────────────
    // El calendario lo aporta la PRIMERA historia vinculada que defina uno; sin
    // ninguno se usa el gregoriano. El reloj es autoridad del servidor: aquí se
    // renderiza la cabecera canónica y el modelo solo la copia (ver
    // buildWorldHeaderBlock). El avance del reloj se aplica DESPUÉS de generar,
    // al parsear [TIEMPO:...].
    const worldCalendar = linkedStories.find((s) => s.calendar)?.calendar ?? null;
    const worldState = normalizeWorldState(
      (conversation.metadata as { worldState?: WorldState } | null)?.worldState,
    );
    // Sin anclar → sin cabecera: se le pide al modelo que declare la escena en
    // vez de imponerle una hora y un lugar que pueden contradecir lo narrado.
    const worldHeader = worldState.established
      ? formatHeader(computeClock(worldState, worldCalendar), conversation.currentLocation)
      : null;

    // Detección de acción física/sexual del jugador. Se calcula ANTES de construir
    // el contexto porque decide si se inyecta el reglamento largo de consentimiento
    // (~2.000 tok); más abajo se reutiliza para la directiva de comportamiento.
    const playerAction = detectPlayerAction(userMessageForAnalysis);

    // Hilos narrativos abiertos — deuda de la partida que no debe diluirse.
    const openThreads = threadRepo.findOpen(conversationId);
    // Índice del turno actual, para calcular la antigüedad de cada hilo.
    const currentMessageIndex = historyForContext.length + 1;

    // Estado del director de escena (situación, tensión, estado interno por
    // personaje, PNJs). Lo mantiene updateSceneStateAsync en segundo plano.
    const sceneState =
      ((conversation.metadata as { sceneState?: SceneDirectorState } | null)?.sceneState) ?? null;

    const { messages: rawContext, footerCount } = await buildContext({
      character: character ?? groupCharacters[0],
      stories: linkedStories,
      messages: [...historyForContext, { ...userMsg, role: 'user' as const }],
      conversationId,
      globalSystemPrompt: settings.globalSystemPrompt,
      maxMessages,
      summary: conversation.summary,
      blockSummaries: summariesRepo.findBlocks(conversationId),
      arcSummaries: summariesRepo.findArcs(conversationId),
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
      livingWorldPrompt: settings.livingWorldPrompt,
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
      playerSheet,
      playerDisplayName:   opts.userDisplayName,
      occurredEventIds,
      deathModeActive,
      deathLoop: currentDeathLoop,
      worldHeader,
      worldTrackingEnabled: true,
      intimacyContext: playerAction !== null,
      sceneState,
      openThreads,
      currentMessageIndex,
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
        conversationId,
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
      // Mismo patrón que temperature: el ajuste global manda sobre el valor por
      // personaje. Modo thinking los ignora todos (ver provider).
      topP: settings.generationTopP ?? activeChar?.llmParams?.topP,
      topK: activeChar?.llmParams?.topK,
      repetitionPenalty: settings.generationFrequencyPenalty ?? activeChar?.llmParams?.repetitionPenalty,
      presencePenalty: settings.generationPresencePenalty ?? activeChar?.llmParams?.presencePenalty,
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

    // ── Hilos narrativos: [HILO_ABIERTO:...] / [HILO_CERRADO:...] ─────────────
    // Se CIERRA antes de abrir: si en el mismo turno el modelo resuelve un hilo y
    // plantea otro con un título parecido, cerrar primero evita que el recién
    // abierto absorba el cierre por el emparejado tolerante de `close()`.
    // Las etiquetas se eliminan siempre del contenido visible, aunque el parseo
    // falle — un marcador técnico nunca debe llegar al jugador.
    const THREAD_OPEN_RE  = /\[HILO_ABIERTO:\s*([^\]|]{1,120}?)\s*(?:\|\s*([^\]|]{0,400}?)\s*)?(?:\|\s*(\d{1,2})\s*)?\]/gi;
    const THREAD_CLOSE_RE = /\[HILO_CERRADO:\s*([^\]]{1,120}?)\s*\]/gi;

    const threadOpenMatches  = [...cleanContent.matchAll(THREAD_OPEN_RE)];
    const threadCloseMatches = [...cleanContent.matchAll(THREAD_CLOSE_RE)];
    cleanContent = cleanContent.replace(THREAD_OPEN_RE, '').replace(THREAD_CLOSE_RE, '').trimEnd();

    if (!aborted) {
      for (const m of threadCloseMatches) {
        const closed = threadRepo.close(conversationId, m[1], currentMessageIndex);
        if (closed) console.log(`[threads] Cerrado: «${closed.title}»`);
        else console.warn(`[threads] [HILO_CERRADO:${m[1]}] no casa con ningún hilo abierto — ignorado`);
      }
      for (const m of threadOpenMatches) {
        const title = m[1]?.trim();
        if (!title) continue;
        // La importancia declarada se acota al rango válido; sin ella, 5 (media).
        const rawImp = m[3] ? Number(m[3]) : 5;
        const importance = Math.min(10, Math.max(1, Number.isFinite(rawImp) ? rawImp : 5));
        const { thread, created } = threadRepo.open({
          conversationId,
          title,
          description: m[2]?.trim() ?? '',
          importance,
          openedAtIndex: currentMessageIndex,
        });
        console.log(`[threads] ${created ? 'Abierto' : 'Refrescado'}: «${thread.title}» (imp. ${thread.importance})`);
      }
    }
    // ─────────────────────────────────────────────────────────────────────────

    // ── Paso del tiempo y clima: [TIEMPO:...] / [CLIMA:...] ───────────────────
    // El modelo declara CUÁNTO tiempo consumió lo que narró; el servidor lo
    // traduce a minutos y lo suma al contador. Sin etiqueta el reloj avanza igual
    // (DEFAULT_ADVANCE_MINUTES): si el tiempo solo corriera cuando el modelo se
    // acuerda de la etiqueta, una escena larga de diálogo congelaría el mundo.
    // No se aplica en respuestas abortadas: media respuesta no consume tiempo.
    const TIME_RE    = /\[TIEMPO:\s*([^\]]{1,40}?)\s*\]/gi;
    const WEATHER_RE = /\[CLIMA:\s*([^\]]{1,60}?)\s*\]/gi;
    const SCENE_RE   = /\[ESCENA:\s*([^\]]{1,120}?)\s*\]/gi;

    // Cabecera a mostrar en ESTA respuesta; se recalcula abajo si el modelo corrigió.
    let headerForDisplay: string | null = worldHeader;
    const timeMatches    = [...cleanContent.matchAll(TIME_RE)];
    const weatherMatches = [...cleanContent.matchAll(WEATHER_RE)];
    const sceneMatches   = [...cleanContent.matchAll(SCENE_RE)];
    cleanContent = cleanContent
      .replace(TIME_RE, '').replace(WEATHER_RE, '').replace(SCENE_RE, '').trimEnd();

    if (!aborted) {
      // [ESCENA:...] tiene prioridad sobre [TIEMPO:...]: es una corrección
      // (o el anclaje inicial), no un avance. Si el modelo emite ambas, manda la
      // corrección — el avance relativo partiría de una hora que él ya declaró mala.
      const sceneRaw = sceneMatches.at(-1)?.[1];
      const scene = sceneRaw ? parseSceneTag(sceneRaw) : null;

      let minutesElapsed: number;
      if (scene?.minuteOfDay != null) {
        minutesElapsed = applySceneTime(worldState, worldCalendar, scene.minuteOfDay);
        console.log(`[world] Escena ${worldState.established ? 'corregida' : 'anclada'} → ${sceneRaw}`);
      } else {
        // Última ocurrencia = la más autoritativa (igual criterio que [UBICACION:]).
        const rawAdvance = timeMatches.at(-1)?.[1];
        const parsed = rawAdvance
          ? parseTimeAdvance(rawAdvance, currentMinuteOfDay(worldState, worldCalendar))
          : null;
        if (rawAdvance && parsed === null) {
          console.warn(`[world] [TIEMPO:${rawAdvance}] no reconocido — aplicando avance por defecto`);
        }
        // Mientras la escena no esté anclada el reloj NO corre: avanzar un tiempo
        // que no sabemos desde cuándo cuenta solo acumula error.
        const advance = worldState.established ? (parsed ?? DEFAULT_ADVANCE_MINUTES) : 0;
        minutesElapsed = worldState.minutesElapsed + advance;
      }

      // El lugar declarado en [ESCENA:...] actualiza la ubicación igual que
      // [UBICACION:], sin que el modelo tenga que emitir las dos etiquetas.
      if (scene?.location) {
        locationUpdate = scene.location;
        convRepo.updateLocation(conversationId, scene.location);
      }

      const nextWorldState: WorldState = {
        minutesElapsed,
        weather: weatherMatches.at(-1)?.[1]?.trim() || worldState.weather,
        // Queda anclada en cuanto el modelo declara una hora válida.
        established: worldState.established || scene?.minuteOfDay != null,
        updatedAt: new Date().toISOString(),
      };
      // Merge sobre metadata FRESCO para no pisar partyState/deathLoop/resúmenes.
      const freshForWorld = convRepo.findById(conversationId);
      if (freshForWorld) {
        convRepo.update(conversationId, {
          metadata: { ...freshForWorld.metadata, worldState: nextWorldState },
        });
      }

      // Cabecera que se MUESTRA en esta respuesta. Se distingue corrección de avance:
      //   · [ESCENA:...] es una corrección (o el anclaje) → la cabecera de esta misma
      //     respuesta debe reflejar ya el valor corregido; si no, se sustituiría por
      //     la obsoleta que el modelo acaba de declarar equivocada.
      //   · [TIEMPO:+3h] es tiempo consumido DURANTE la respuesta → la cabecera abre
      //     la escena y conserva la hora de inicio; el avance se verá en el turno siguiente.
      if (scene?.minuteOfDay != null && nextWorldState.established) {
        headerForDisplay = formatHeader(
          computeClock(nextWorldState, worldCalendar),
          locationUpdate ?? conversation.currentLocation,
        );
      }
      console.log(`[world] ${headerForDisplay ?? '(escena sin anclar — esperando [ESCENA:...])'}`);
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

    // ── Normalización de la cabecera ambiental (mitad "servidor" del híbrido) ──
    // El modelo la escribe para que le cebe el tono de lo que narra a continuación,
    // pero no se le concede autoridad sobre su contenido: si la que emitió no es
    // EXACTA, se sustituye por la canónica; si no la puso, se antepone. Así se
    // conserva el efecto de cebado sin exponer al jugador a la deriva (horas que
    // retroceden, días de la semana que dejan de cuadrar con la fecha).
    if (!aborted && cleanContent.trim()) {
      cleanContent = normalizeWorldHeader(cleanContent, headerForDisplay);
    }

    // Observabilidad del guardián de voz: avisa en cuanto una respuesta narra en
    // primera persona (la directiva correctiva se inyectará en el turno siguiente).
    if (!aborted && cleanContent) {
      const voiceSnippet = detectFirstPersonNarration(cleanContent, narratorMode);
      if (voiceSnippet) {
        console.warn(`[voice-guard] La respuesta recién generada narra en primera persona: "${voiceSnippet}" — se corregirá en el siguiente turno`);
      }
    }

    // ── Tirada de dados: [TIRADA:Quién|Atributo|CD|descripción] ────────────────
    // La ÚLTIMA ocurrencia manda (mismo criterio que UBICACION/EVENTO_OCURRIDO):
    // si el modelo la repite por error de formato, solo la más reciente cuenta.
    // El servidor tira el d20 — el modelo nunca decide el resultado.
    let diceRoll: DiceRollResult | undefined;
    if (!aborted && cleanContent) {
      const diceMatches = [...cleanContent.matchAll(DICE_ROLL_RE)];
      if (diceMatches.length > 0) {
        const m = diceMatches[diceMatches.length - 1];
        const [, whoRaw, attributeRaw, cdRaw, descriptionRaw] = m;
        const cd = Math.min(20, Math.max(1, parseInt(cdRaw, 10) || 10));
        const { sheet, resolvedWho } = resolveRollSheet(whoRaw, playerSheet, opts.userDisplayName, allCharsInConv);
        const modifier = resolveRollModifier(sheet, attributeRaw.trim());
        diceRoll = rollDice(resolvedWho, attributeRaw.trim(), cd, descriptionRaw.trim(), modifier);
        console.log(`[dice] ${diceRoll.who} · ${diceRoll.attribute} (CD ${diceRoll.cd}): ${diceRoll.natural}+${diceRoll.modifier}=${diceRoll.total} → ${diceRoll.critical ?? (diceRoll.success ? 'éxito' : 'fallo')}`);
      }
      cleanContent = cleanContent.replace(DICE_ROLL_RE, '').trimEnd();
    }
    // ─────────────────────────────────────────────────────────────────────────

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
        ...(diceRoll ? { diceRoll } : {}),
        promptMessages: trimmedMessages,
      },
    });

    if (!aborted) {
      convRepo.incrementCounts(conversationId, finalTokens);
      onDone({ messageId: assistantMsg.id, userMessageId: userMsg.id, tokens: finalTokens, tokenBreakdown, promptMessages: trimmedMessages, affinityUpdates, fastLlmDebug, narrator: narratorMode, characterId: assistantMsg.characterId ?? null, content: cleanContent, locationUpdate, thinkContent: thinkAccumulated || undefined, deathLoop: deathLoopUpdate, diceRoll });

      // ── Enriquecimiento de fondo, secuencial y con progreso visible ─────────
      //
      // El mensaje ya está persistido y visible (onDone ya se llamó): esto NO
      // bloquea el chat, el jugador puede seguir escribiendo de inmediato. Antes
      // estas llamadas eran fire-and-forget (`void ...Async(...)`) y corrían en
      // silencio; el usuario veía pausas largas entre turnos sin saber que el
      // servidor seguía llamando al LLM de fondo (anclaje del mundo, director de
      // escena, resúmenes, índice de contexto).
      //
      // Se ejecutan en secuencia (no en paralelo) por dos motivos: evitar
      // carreras de escritura sobre el mismo conversation.metadata (cada una
      // hace su propio merge "leer-modificar-persistir"), y para que el
      // progreso "paso N/M" reportado al cliente sea literal, no una foto
      // aproximada de tareas en vuelo.
      //
      // La lista de pasos se decide ANTES de ejecutar nada, con comprobaciones
      // baratas (sin LLM) que reflejan exactamente la condición de "no-op" de
      // cada función real — así el total mostrado es el nº de llamadas al LLM
      // que de verdad van a ocurrir, ni una más ni una menos salvo la rara
      // carrera de un segundo turno concurrente en la misma conversación.
      const updatedConvForCount = convRepo.findById(conversationId);
      const currentTotalMessages = updatedConvForCount?.messageCount ?? 0;
      const personalSummaryChar = !narratorMode && contextGroupChars.length > 0 ? character : null;
      const personalSummaryDue = Boolean(personalSummaryChar) && currentTotalMessages % SUMMARY_EVERY_N === 0;
      const blockSummaryDue = hasPendingSummaryWork(conversationId, branchId);

      const enrichSteps: Array<{ label: string; run: () => Promise<void> }> = [];

      if (!worldState.established) {
        enrichSteps.push({
          label: 'Anclando la escena en el tiempo y el lugar…',
          run: () => bootstrapWorldStateAsync(conversationId, provider, modelId, worldCalendar),
        });
      }
      if (isSceneDirectorDue(sceneState, currentMessageIndex + 1)) {
        enrichSteps.push({
          label: useFastLlm
            ? 'Actualizando lo que piensa y siente cada personaje…'
            : 'Actualizando lo que piensa y siente cada personaje, y su memoria…',
          // Sin LLM rápido, esta es la ÚNICA vía de creación de memorias
          // (analyzeExchangeAsync, más abajo, nunca se ejecuta). Con LLM rápido
          // activo se deja en false para no duplicar — ese analizador ya cubre
          // memoria con su propia cadencia por turno.
          run: () => updateSceneStateAsync(conversationId, provider, modelId, !useFastLlm),
        });
      }
      if (blockSummaryDue || personalSummaryDue) {
        const label =
          blockSummaryDue && personalSummaryDue
            ? `Actualizando la memoria de la historia y el resumen de ${personalSummaryChar!.name}…`
            : blockSummaryDue
            ? 'Actualizando la memoria de la historia…'
            : `Actualizando el resumen personal de ${personalSummaryChar!.name}…`;
        enrichSteps.push({
          label,
          run: () => updateSummaryAsync(conversationId, provider, modelId, personalSummaryChar, branchId),
        });
      }
      if (hasPendingContextExtraction(conversationId, currentTotalMessages)) {
        enrichSteps.push({
          label: 'Actualizando el índice de contexto…',
          run: () => autoExtractContextAsync(conversationId, currentTotalMessages),
        });
      }

      for (let i = 0; i < enrichSteps.length; i++) {
        onEnrichStep?.({ index: i + 1, total: enrichSteps.length, label: enrichSteps[i].label });
        try {
          await enrichSteps[i].run();
        } catch (err) {
          // Cada función ya se protege internamente (non-critical, log y sigue);
          // esta captura es solo para que un fallo inesperado no tumbe el resto
          // de la pasada de enriquecimiento.
          console.error(`[enrich] Paso "${enrichSteps[i].label}" falló:`, err);
        }
      }

      // Coste de fondo del turno = diferencia entre el acumulado de la
      // conversación al empezar y al terminar. Cubre TODAS las llamadas de
      // fondo del turno (moderación y pre-análisis incluidas, que corren antes
      // de generar). Se adjunta al mensaje para que el desglose sobreviva a la
      // recarga, y viaja en enrich_done para pintarse al momento.
      let turnBgTokens: import('@rpgspeak/shared').BackgroundTokenUsage | undefined;
      const convAfterEnrich = convRepo.findById(conversationId);
      if (convAfterEnrich) {
        const delta = diffBgUsage(bgUsageBefore, readBgUsage(convAfterEnrich.metadata));
        if (delta.calls > 0) {
          turnBgTokens = delta;
          const freshMsg = msgRepo.findById(assistantMsg.id);
          if (freshMsg) {
            msgRepo.update(assistantMsg.id, { metadata: { ...freshMsg.metadata, bgTokens: delta } });
          }
        }
      }
      onEnrichDone?.(turnBgTokens ? { bgTokens: turnBgTokens } : undefined);
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

    recordBgUsage(conversationId, 'analisis-fast', (result as import('@rpgspeak/shared').GenerateResponse).tokens);
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

// ── Pirámide de resúmenes ────────────────────────────────────────────────────
//
// Dos niveles inmutables, generados con el LLM principal:
//   · BLOQUE (~blockSize msgs): detalle alto, con textura relacional — no solo
//     el inventario de la trama sino qué cambió entre los personajes, qué quedó
//     sin decir y con qué ánimo terminó cada uno. Antes se pedían 5 frases de
//     puro plot y el pasado perdía toda su textura.
//   · ARCO (ARC_BLOCK_SPAN bloques consecutivos): el pasado lejano, más
//     comprimido pero conservando el arco relacional y lo que sigue abierto.
// Los ARC_DETAIL_RESERVE bloques más recientes nunca entran en un arco: son el
// pasado cercano y se inyectan con su detalle completo (ver buildContext).

// Cadencia del resumen personal por personaje (rodante). Nivel de módulo (antes
// local a updateSummaryAsync) porque el chequeo de elegibilidad del indicador
// de progreso necesita la misma constante ANTES de llamar a la función real.
const SUMMARY_EVERY_N = 6;

const ARC_BLOCK_SPAN     = 4; // bloques por arco
const ARC_DETAIL_RESERVE = 2; // bloques recientes que siempre quedan en detalle
// Tope de arcos por pasada: una conversación larga preexistente puede deber
// muchos arcos de golpe (puesta al día); se generan a razón de unos pocos por
// turno para no convertir la tarea de fondo en una ráfaga de llamadas al LLM.
const MAX_ARCS_PER_PASS  = 3;

/**
 * Chequeo barato (sin llamadas al LLM) de si `generateBlockSummaries` va a
 * tener trabajo real que hacer. Lo usa el indicador de progreso del turno para
 * saber, ANTES de ejecutar nada, si este paso merece anunciarse.
 *
 * Duplica la aritmética de arriba (no la lógica de condensación) a propósito:
 * es una comprobación de unas pocas lecturas de BD, y math desincronizada aquí
 * en el peor caso hace que el paso se anuncie y resulte un no-op casi
 * instantáneo — nunca al revés (trabajo real sin anunciar).
 */
export function hasPendingSummaryWork(conversationId: string, branchId: string): boolean {
  if (branchId !== 'main') return false;
  const settings  = settingsService.getAll();
  const blockSize = Math.max(10, settings.summaryBlockSize ?? 40);

  const totalMessages   = msgRepo.findByConversation(conversationId).length;
  const completedBlocks = Math.floor(totalMessages / blockSize);
  if (completedBlocks === 0) return false;

  const blocks = summariesRepo.findBlocks(conversationId);
  if (completedBlocks > blocks.length) return true; // bloque nuevo pendiente

  const arcs    = summariesRepo.findArcs(conversationId);
  const arcable = blocks.length - ARC_DETAIL_RESERVE;
  const nextArcFrom = arcs.length * ARC_BLOCK_SPAN;
  return arcable - nextArcFrom >= ARC_BLOCK_SPAN; // arco nuevo pendiente
}

async function generateBlockSummaries(
  conversationId: string,
  provider: NonNullable<ReturnType<ProviderRepository['findById']>>,
  modelId: string,
  branchId = 'main',
): Promise<void> {
  // Los índices de los bloques se calculan sobre la lista de mensajes de la rama
  // principal (la misma que ve buildContext). En una rama alternativa esa
  // numeración no coincide y los bloques generados corromperían la inyección de
  // TODAS las ramas — mejor no generar que generar mal.
  if (branchId !== 'main') return;

  const conv = convRepo.findById(conversationId);
  if (!conv) return;

  const settings  = settingsService.getAll();
  const blockSize = Math.max(10, settings.summaryBlockSize ?? 40);
  const maxFrases = settings.summaryMaxLength ?? 5;
  // Presupuestos de la pirámide, derivados del ajuste editable del usuario:
  // bloque con textura ≈ el doble + 2 (12 con el default 5); arco ≈ el doble.
  const blockFrases = maxFrases * 2 + 2;
  const arcFrases   = maxFrases * 2;

  const allMessages     = msgRepo.findByConversation(conversationId);
  const completedBlocks = Math.floor(allMessages.length / blockSize);
  if (completedBlocks === 0) return;

  // Limpieza de duplicados históricos (carrera de pasadas concurrentes): sin
  // esto, `covered` y la agrupación de arcos trabajarían sobre datos repetidos
  // y "Historia hasta ahora" inyectaría el mismo contenido dos veces.
  const deduped = summariesRepo.dedupeBlocks(conversationId);
  if (deduped > 0) console.warn(`[summary] ${deduped} resumen(es) duplicado(s) eliminados en conv ${conversationId}`);

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
      `Escribe un resumen SOLO del fragmento, fiel a lo narrado y en pasado narrativo. Debe capturar DOS planos:\n` +
      `1. LOS HECHOS: nombres propios, lugares, objetos relevantes, promesas, decisiones, heridas o cambios de estado.\n` +
      `2. LA TEXTURA — esto es tan importante como los hechos:\n` +
      `   - Qué cambió entre los personajes en este fragmento (acercamiento, fricción, una deuda nueva, un límite marcado)\n` +
      `   - Qué quedó SIN decir o sin resolver: la pregunta esquivada, la verdad callada, la tensión que sigue viva\n` +
      `   - Con qué estado de ánimo terminó cada personaje relevante el fragmento\n` +
      `- Máximo ${blockFrases} frases. Prioriza la información que un narrador necesitaría para retomar la historia SIN aplanar a los personajes.\n` +
      `- Sin explicaciones ni frases introductorias.\n\n` +
      `Responde SOLO con el texto del resumen.`;

    const response = await llm.generate({
      messages: [
        { role: 'system', content: 'Eres un cronista que resume fragmentos de una historia colaborativa de rol, atendiendo tanto a los hechos como a la evolución de las relaciones.' },
        { role: 'user', content: prompt },
      ],
      model: modelId,
      temperature: 0.3,
      stream: false,
      disableFallbacks: settings.disableFallbacks,
    } satisfies GenerateRequest);

    recordBgUsage(conversationId, 'resumen-bloque', response.tokens);
    const content = response.content.trim();
    if (!content) return; // el LLM falló: se reintentará en el próximo turno

    summariesRepo.create({ conversationId, content, messageIndexFrom: from, messageIndexTo: to, kind: 'block' });
    console.log(`[summary] Bloque ${from + 1}–${to + 1} resumido para conv ${conversationId}`);
    prevContent = content;
  }

  // ── Consolidación en arcos ─────────────────────────────────────────────────
  // Se condensan grupos de ARC_BLOCK_SPAN bloques consecutivos, dejando siempre
  // los ARC_DETAIL_RESERVE más recientes fuera (pasado cercano, en detalle).
  // Trabaja sobre los TEXTOS de los bloques (no relee mensajes): barato, y los
  // bloques ya llevan la textura que el arco debe conservar.
  const blocks = summariesRepo.findBlocks(conversationId);
  const arcs   = summariesRepo.findArcs(conversationId);
  const arcable = blocks.slice(0, Math.max(0, blocks.length - ARC_DETAIL_RESERVE));

  let arcsThisPass = 0;
  for (let g = 0; g + ARC_BLOCK_SPAN <= arcable.length; g += ARC_BLOCK_SPAN) {
    if (arcsThisPass >= MAX_ARCS_PER_PASS) break; // el resto, en próximos turnos
    const group = arcable.slice(g, g + ARC_BLOCK_SPAN);
    const from  = group[0].messageIndexFrom;
    const to    = group[group.length - 1].messageIndexTo;
    if (arcs.some((a) => a.messageIndexFrom === from)) continue; // ya condensado

    const arcPrompt =
      `Estos son ${group.length} resúmenes consecutivos de una historia de rol (mensajes ${from + 1}–${to + 1}). ` +
      `Condénsalos en UN resumen de arco.\n\n` +
      group.map((b, i) => `RESUMEN ${i + 1} [msgs ${b.messageIndexFrom + 1}–${b.messageIndexTo + 1}]:\n${b.content}`).join('\n\n') +
      `\n\nEl arco debe conservar, por este orden de prioridad:\n` +
      `1. El ARCO RELACIONAL: cómo evolucionó cada relación a lo largo del tramo (de dónde a dónde), y las deudas o tensiones que siguen ABIERTAS al final.\n` +
      `2. Los hechos irreversibles: promesas, heridas, objetos que cambiaron de manos, secretos revelados, decisiones sin vuelta atrás.\n` +
      `3. La cronología esencial de la trama.\n` +
      `Puede DESCARTAR lo episódico ya cerrado y sin consecuencias.\n` +
      `- Máximo ${arcFrases} frases, en pasado narrativo.\n` +
      `- Sin explicaciones ni frases introductorias.\n\n` +
      `Responde SOLO con el texto del arco.`;

    const response = await llm.generate({
      messages: [
        { role: 'system', content: 'Eres un cronista que condensa tramos largos de una historia de rol conservando la evolución de las relaciones y lo que sigue abierto.' },
        { role: 'user', content: arcPrompt },
      ],
      model: modelId,
      temperature: 0.3,
      stream: false,
      disableFallbacks: settings.disableFallbacks,
    } satisfies GenerateRequest);

    recordBgUsage(conversationId, 'resumen-arco', response.tokens);
    const content = response.content.trim();
    if (!content) return;

    summariesRepo.create({ conversationId, content, messageIndexFrom: from, messageIndexTo: to, kind: 'arc' });
    arcsThisPass++;
    console.log(`[summary] Arco ${from + 1}–${to + 1} condensado (${group.length} bloques) para conv ${conversationId}`);
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
  // ×3 (antes ×2): el rodante se reescribe entero en cada pasada y con el
  // presupuesto justo cada reescritura recomprimía lo anterior — a diez ciclos,
  // el principio de la relación quedaba en media frase. Más techo + la regla de
  // hitos de abajo frenan esa degradación.
  const maxFrasesTotal = maxFrases * 3;

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
- HITOS INTOCABLES: los momentos que definieron la relación con el jugador (el primer encuentro, una confesión, una promesa, una traición, un límite marcado) se CONSERVAN como frases propias, con su detalle — no se funden ni se recomprimen en cada actualización. Si un hito ya está en el resumen anterior, cópialo casi literal.
- Lo cotidiano sin consecuencias sí puede comprimirse o desaparecer para hacer sitio.
- Conserva además: el estado ACTUAL de la relación, y lo que ${character.name} tiene pendiente o sin decir con el jugador
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
  recordBgUsage(conversationId, 'resumen-personaje', response.tokens);
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

// ─── Anclaje inicial de la escena ─────────────────────────────────────────────
//
// Averigua hora y lugar leyendo la conversación, en una llamada dedicada al
// provider PRINCIPAL, una sola vez por conversación.
//
// El primer intento fue pedírselo al propio turno narrativo con una etiqueta
// [ESCENA:...]. No funcionó: el bloque llegaba al prompt en la última posición
// antes del mensaje del jugador —la de máxima obediencia— y el modelo lo
// ignoraba igual. Es lógico: en mitad de una escena se le pedía una tarea de
// contabilidad ajena a lo que estaba escribiendo, compitiendo con otras cinco
// etiquetas técnicas. Una llamada aparte y con un único cometido no compite con
// nada, y esto solo hay que resolverlo una vez.
//
// La corrección posterior SÍ sigue en manos del turno narrativo ([ESCENA:...]),
// donde el gesto es natural: arreglar una cabecera que uno ve equivocada delante.
export async function bootstrapWorldStateAsync(
  conversationId: string,
  provider: ReturnType<ProviderRepository['findById']>,
  modelId: string,
  calendar: StoryCalendar | null,
): Promise<void> {
  if (!provider) return;
  try {
    const conv = convRepo.findById(conversationId);
    if (!conv) return;
    const state = normalizeWorldState((conv.metadata as { worldState?: WorldState } | null)?.worldState);
    if (state.established) return; // ya anclada

    const recent = msgRepo.findByConversation(conversationId)
      .filter((m) => m.role !== 'system')
      .slice(-10);
    if (recent.length < 2) return; // aún no hay escena que leer

    const transcript = labelSpeakers(recent as Message[]);
    const settings = settingsService.getAll();
    const llm = createProvider(provider);

    const response = await llm.generate({
      messages: [
        { role: 'system', content: 'Extraes datos de escena de una historia de rol. Respondes solo con el dato pedido, sin explicaciones.' },
        { role: 'user', content:
          `Lee este fragmento y determina CUÁNDO y DÓNDE transcurre la escena en este momento.\n\n` +
          `---\n${transcript}\n---\n\n` +
          `Responde EXACTAMENTE en este formato, sin nada más:\n` +
          `HH:MM|lugar\n\n` +
          `- HH:MM en formato 24h. Dedúcelo de lo que se narra (si se están acostando será de noche, si desayunan será por la mañana). Si no hay ninguna pista, usa 12:00.\n` +
          `- El lugar, en pocas palabras y tal como se llama en la historia (por ejemplo: dormitorio de Rika, taberna del Jabalí, camino a la aldea).\n` +
          `Ejemplo de respuesta válida: 23:15|dormitorio de Rika` },
      ],
      model: modelId,
      temperature: 0.2,
      maxTokens: 40,
      stream: false,
      disableFallbacks: settings.disableFallbacks,
    });

    recordBgUsage(conversationId, 'anclaje-mundo', response.tokens);
    const raw = response.content.trim().split('\n')[0].replace(/[`*[\]]/g, '').trim();
    const scene = parseSceneTag(raw);
    if (scene.minuteOfDay == null) {
      console.warn(`[world] Anclaje automático fallido, respuesta no interpretable: "${raw}" — se reintentará`);
      return;
    }

    // Merge sobre metadata FRESCO: han podido escribirse resúmenes entre medias.
    const fresh = convRepo.findById(conversationId);
    if (!fresh) return;
    const freshState = normalizeWorldState((fresh.metadata as { worldState?: WorldState } | null)?.worldState);
    if (freshState.established) return; // otra ejecución se adelantó

    convRepo.update(conversationId, {
      metadata: {
        ...fresh.metadata,
        worldState: {
          minutesElapsed: applySceneTime(freshState, calendar, scene.minuteOfDay),
          weather: freshState.weather,
          established: true,
          updatedAt: new Date().toISOString(),
        } satisfies WorldState,
      },
    });
    if (scene.location) convRepo.updateLocation(conversationId, scene.location);
    console.log(`[world] Escena anclada automáticamente: ${raw}`);
  } catch (err) {
    console.error('[world] Error en el anclaje automático:', err);
  }
}

// ─── Director de escena ───────────────────────────────────────────────────────
//
// Mantiene el estado que convierte una ficha en una persona: situación inmediata,
// tensión, qué quiere/teme cada personaje AHORA, y el registro de PNJs sin ficha.
// Llamada dedicada al LLM PRINCIPAL cada ~SCENE_DIRECTOR_STALE_AFTER mensajes —
// no etiquetas en mitad de la narración, que el modelo ignora (lección del
// anclaje de escena), ni fast LLM, que en producción no existe.

const SCENE_DIRECTOR_STALE_AFTER = 6;   // mensajes entre actualizaciones
const SCENE_DIRECTOR_MAX_NPCS    = 6;

/** Único punto de verdad de "¿toca actualizar el director de escena?". La usa
 *  tanto la función real como el indicador de progreso del turno (necesita
 *  saber, ANTES de ejecutar nada, si este paso va a hacer trabajo real). */
export function isSceneDirectorDue(prev: SceneDirectorState | null, currentIndex: number): boolean {
  if (currentIndex < 4) return false; // aún no hay escena que dirigir
  if (prev && currentIndex - prev.updatedAtIndex < SCENE_DIRECTOR_STALE_AFTER) return false;
  return true;
}

// ── Umbrales de importancia para memorias extraídas por el director ─────────
//
// Antes la ÚNICA vía para crear memorias era `analyzeExchangeAsync` (LLM
// rápido), con un filtro deliberadamente brutal ("90% NINGUNO", tipos
// relación/preferencia PROHIBIDOS) porque corría en CADA turno — sin ese
// filtro, cada charla trivial generaría ruido.
//
// Aquí el cálculo es distinto: esto corre cada SCENE_DIRECTOR_STALE_AFTER
// mensajes (~6), no cada turno, así que la densidad esperada de "algo memorable
// en esta ventana" es mayor y el filtro puede aflojarse. Y a diferencia del
// analizador rápido, aquí SÍ se admite relación/preferencia — un gusto revelado
// o un patrón en cómo trata al jugador es exactamente lo que hace a un
// personaje distinto de una ficha en blanco, y antes estaba prohibido guardarlo.
const MEMORY_TYPE_MAP: Record<string, MemoryEntry['type']> = {
  evento: 'event', hecho: 'fact', ofensa: 'offense', trauma: 'trauma',
  relacion: 'relationship', preferencia: 'preference',
};
const MEMORY_MIN_IMPORTANCE: Record<MemoryEntry['type'], number> = {
  event: 7, fact: 7, offense: 7, trauma: 7,
  relationship: 5, preference: 5, summary: 7,
};

// Formato con PIPES, igual que [PERSONAJE:...] y [PNJ:...] de arriba — a
// propósito. La primera versión usaba dos puntos + etiqueta de cierre
// ([MEMORIA:Nombre:tipo:importancia]…[/MEMORIA]), y en pruebas reales el
// modelo la confundía con el resto del formato del propio prompt: escribía
// literalmente la palabra "importancia" donde debía ir un número, o mezclaba
// tipo e importancia, e ignoraba el cierre — probablemente por chocar con la
// convención de pipes que el MISMO prompt usa dos líneas antes. Unificar a
// pipes (que el modelo ya rellena bien para PERSONAJE/PNJ en esta misma
// respuesta) resolvió la incoherencia. Incluye un ejemplo con un número real:
// un placeholder abstracto ("importancia") es la puerta que llevaba a copiarlo
// literal en vez de sustituirlo.
const MEMORY_EXTRACTION_INSTRUCTION =
  `\n\nADEMÁS: si algo de este fragmento merece recordarse de forma DURADERA (para conversaciones futuras, no solo para esta escena), añade una etiqueta por hecho, con el MISMO formato de pipes que arriba:\n` +
  `[MEMORIA:Nombre|tipo|importancia|descripción concisa en tercera persona]\n` +
  `Ejemplo real (fíjate en que "importancia" es un NÚMERO, no la palabra "importancia"): [MEMORIA:Rika|trauma|8|Rika reveló que su padre la abandonó de niña y aún le cuesta confiar]\n\n` +
  `TIPOS (usa exactamente una de estas seis palabras) Y UMBRAL DE IMPORTANCIA (1-10):\n` +
  `- evento, hecho, ofensa, trauma → SOLO si importancia ≥ 7 (objeto entregado, herida o cicatriz, promesa o juramento, secreto revelado por primera vez, traición, daño psicológico duradero)\n` +
  `- relacion, preferencia → SOLO si importancia ≥ 5 (un gusto o costumbre que el personaje reveló, un patrón en cómo trata al jugador, una confidencia genuina)\n` +
  `La mayoría de fragmentos de 6 mensajes no dejan nada de este calibre — no fuerces una etiqueta si no la hay. Pero a diferencia de la situación/tensión de arriba, esto debe capturar lo que hace a cada personaje distinto: sus gustos, manías y la forma particular en que trata al jugador, no solo los hechos de la trama.`;

export async function updateSceneStateAsync(
  conversationId: string,
  provider: ReturnType<ProviderRepository['findById']>,
  modelId: string,
  /** true cuando el LLM rápido está apagado: sin él, `analyzeExchangeAsync`
   *  nunca corre y esta es la ÚNICA vía de creación de memorias. Con el LLM
   *  rápido activo, se deja false para no duplicar — ese analizador ya cubre
   *  memoria (y afinidad) con su propia cadencia por turno. */
  extractMemories = false,
): Promise<void> {
  if (!provider) return;
  try {
    const conv = convRepo.findById(conversationId);
    if (!conv) return;

    const allMessages = msgRepo.findByConversation(conversationId)
      .filter((m) => m.role !== 'system');
    const currentIndex = allMessages.length;

    const prev = (conv.metadata as { sceneState?: SceneDirectorState } | null)?.sceneState ?? null;
    if (!isSceneDirectorDue(prev, currentIndex)) return;

    const cast = conv.characters
      .map((c) => charRepo.findById(c.characterId))
      .filter((c): c is Character => c !== null);
    const transcript = labelSpeakers(allMessages.slice(-14) as Message[]);

    // Estado previo serializado: el director EVOLUCIONA estados, no los reinventa.
    const prevCharLines = prev
      ? cast
          .filter((c) => prev.characters[c.id])
          .map((c) => {
            const s = prev.characters[c.id];
            return `- ${c.name}: quiere «${s.quiere}» · le preocupa «${s.preocupa}» · pendiente «${s.pendiente}» · última impresión «${s.impresion}»`;
          })
          .join('\n')
      : '';
    const prevNpcLines = prev?.npcs.length
      ? prev.npcs.map((n) => `- ${n.nombre}: ${n.rasgo} · ${n.estado} · ${n.conoceAlJugador ? 'conoce al jugador' : 'NO conoce al jugador'}`).join('\n')
      : '';

    const settings = settingsService.getAll();
    const llm = createProvider(provider);
    const response = await llm.generate({
      messages: [
        {
          role: 'system',
          content:
            'Eres el director de escena de una historia de rol: mantienes el estado interno de los personajes ' +
            'entre bambalinas. Piensas en términos de deseos, miedos y cuentas pendientes — no de resúmenes de trama. ' +
            'Respondes SOLO en el formato pedido, sin explicaciones.',
        },
        {
          role: 'user',
          content:
            `PERSONAJES CON FICHA (los únicos válidos para [PERSONAJE:...]):\n${cast.map((c) => `- ${c.name}`).join('\n')}\n\n` +
            (prevCharLines ? `ESTADO ANTERIOR (evolúcialo con lo nuevo, no lo reinventes):\n${prevCharLines}\n\n` : '') +
            (prevNpcLines ? `PNJs YA REGISTRADOS:\n${prevNpcLines}\n\n` : '') +
            `FRAGMENTO RECIENTE:\n---\n${transcript}\n---\n\n` +
            `Responde EXACTAMENTE con este formato (una línea por etiqueta, nada más):\n\n` +
            `SITUACION: qué está pasando AHORA y qué está en juego, en una o dos frases\n` +
            `TENSION: calma | inquietud | alerta | peligro — causa breve\n` +
            `[PERSONAJE:Nombre|qué quiere ahora|qué le preocupa|qué tiene pendiente con el jugador|qué se llevó del último encuentro]\n` +
            `[PNJ:Nombre|rasgo dominante|estado emocional actual|conoce al jugador: sí/no]\n\n` +
            `Reglas:\n` +
            `- SOLO personajes y PNJs que aparecen o pesan en el fragmento. No inventes a nadie.\n` +
            `- Cada campo: una frase corta y CONCRETA, anclada en lo narrado — nada de vaguedades («quiere ser feliz» no vale; «quiere que Javier se quede a dormir sin tener que pedírselo» sí).\n` +
            `- El estado interno puede CONTRADECIR lo que el personaje muestra por fuera: eso es lo valioso.\n` +
            `- PNJ = personaje sin ficha (un guardia, un tendero). Si no hay ninguno relevante, no emitas líneas [PNJ:...].` +
            (extractMemories ? MEMORY_EXTRACTION_INSTRUCTION : ''),
        },
      ],
      model: modelId,
      temperature: 0.4,
      // +200 tok de margen cuando también se piden etiquetas [MEMORIA:...].
      maxTokens: extractMemories ? 900 : 700,
      stream: false,
      disableFallbacks: settings.disableFallbacks,
    });

    recordBgUsage(conversationId, 'director-escena', response.tokens);
    const raw = response.content.trim();
    if (process.env.DEBUG_SCENE_DIRECTOR) console.log('[scene-director][DEBUG] raw:\n' + raw);
    const situacion = raw.match(/SITUACI[OÓ]N:\s*(.+)/i)?.[1]?.trim() ?? prev?.situacion ?? '';
    const tension   = raw.match(/TENSI[OÓ]N:\s*(.+)/i)?.[1]?.trim() ?? prev?.tension ?? '';

    const characters: Record<string, CharacterSceneState> = { ...(prev?.characters ?? {}) };
    const PERS_RE = /\[PERSONAJE:\s*([^|\]]+)\|([^|\]]*)\|([^|\]]*)\|([^|\]]*)\|([^\]]*)\]/gi;
    for (const m of raw.matchAll(PERS_RE)) {
      const found = matchCharacterName(m[1], cast);
      if (!found) {
        console.warn(`[scene-director] [PERSONAJE:${m[1].trim()}] no casa con el reparto — ignorado`);
        continue;
      }
      characters[found.id] = {
        quiere:    m[2].trim(),
        preocupa:  m[3].trim(),
        pendiente: m[4].trim(),
        impresion: m[5].trim(),
      };
    }

    // PNJs: merge por nombre (case/tildes-insensible vía lowercase simple); los
    // recién mencionados van al final = se conservan al recortar por el cap.
    const npcs: NpcSceneState[] = [...(prev?.npcs ?? [])];
    const NPC_RE = /\[PNJ:\s*([^|\]]+)\|([^|\]]*)\|([^|\]]*)\|([^\]]*)\]/gi;
    for (const m of raw.matchAll(NPC_RE)) {
      const nombre = m[1].trim();
      if (!nombre) continue;
      const npc: NpcSceneState = {
        nombre,
        rasgo:  m[2].trim(),
        estado: m[3].trim(),
        conoceAlJugador: /s[ií]|yes|true/i.test(m[4]),
      };
      const idx = npcs.findIndex((n) => n.nombre.toLowerCase() === nombre.toLowerCase());
      if (idx !== -1) npcs.splice(idx, 1);
      npcs.push(npc);
    }
    const cappedNpcs = npcs.slice(-SCENE_DIRECTOR_MAX_NPCS);

    // Memorias — solo cuando el LLM rápido está apagado (ver `extractMemories`).
    // Formato de PIPES (no el de dos-puntos+cierre de `analyzeExchangeAsync` más
    // abajo): ver el comentario de MEMORY_EXTRACTION_INSTRUCTION — es el que de
    // verdad rellena bien este modelo en ESTE prompt, al ser consistente con
    // [PERSONAJE:...]/[PNJ:...] que ya usa arriba.
    let memoriesCreated = 0;
    if (extractMemories) {
      const MEMORY_RE = /\[MEMORIA:\s*([^|\]]+)\|([^|\]]*)\|(\d+)\|([^\]]*)\]/gi;
      for (const m of raw.matchAll(MEMORY_RE)) {
        const charName   = m[1].trim();
        const typeRaw    = m[2].trim().toLowerCase();
        const importance = parseInt(m[3], 10);
        const content    = m[4].trim();
        const type = MEMORY_TYPE_MAP[typeRaw];
        if (!type) {
          console.warn(`[scene-director] [MEMORIA:...:${typeRaw}:...] tipo desconocido — ignorada`);
          continue;
        }
        if (!Number.isFinite(importance) || importance < MEMORY_MIN_IMPORTANCE[type]) continue; // backstop de umbral
        const found = matchCharacterName(charName, cast);
        if (!found) {
          console.warn(`[scene-director] [MEMORIA:${charName}:...] no casa con el reparto — ignorada`);
          continue;
        }
        memRepo.create({ conversationId, characterId: found.id, type, content, importance, isActive: true });
        memoriesCreated++;
      }
      if (memoriesCreated > 0) console.log(`[scene-director] ${memoriesCreated} memoria(s) nueva(s) (LLM principal, sin analizador rápido)`);
    }

    if (!situacion && Object.keys(characters).length === 0) {
      console.warn(`[scene-director] Respuesta no interpretable — se reintentará: "${raw.slice(0, 120)}"`);
      return;
    }

    // Merge sobre metadata FRESCO (pueden haberse escrito resúmenes/worldState).
    const fresh = convRepo.findById(conversationId);
    if (!fresh) return;
    convRepo.update(conversationId, {
      metadata: {
        ...fresh.metadata,
        sceneState: {
          situacion, tension, characters, npcs: cappedNpcs,
          updatedAtIndex: currentIndex,
          updatedAt: new Date().toISOString(),
        } satisfies SceneDirectorState,
      },
    });
    console.log(`[scene-director] Estado actualizado (msg ${currentIndex}): ${Object.keys(characters).length} personaje(s), ${cappedNpcs.length} PNJ(s) — «${situacion.slice(0, 80)}»`);
  } catch (err) {
    console.error('[scene-director] Error:', err);
  }
}

/** Conversaciones con una pasada de resúmenes EN CURSO. Es el candado que evita
 *  la carrera que dejó bloques duplicados en BD: la pasada es fire-and-forget y
 *  tarda varios segundos (llamadas al LLM); sin candado, el turno siguiente
 *  lanzaba otra pasada en paralelo y ambas creaban el mismo bloque. */
const summaryPassInFlight = new Set<string>();

async function updateSummaryAsync(
  conversationId: string,
  provider: ReturnType<ProviderRepository['findById']>,
  modelId: string,
  /** Personaje activo del turno (solo modo personaje con grupo) — dispara además
   *  la actualización de su resumen personal. */
  characterForPersonalSummary?: Character | null,
  /** Rama del turno: los bloques solo se generan en 'main' (sus índices se
   *  calculan sobre esa lista de mensajes). */
  branchId = 'main',
): Promise<void> {
  if (!provider) return;
  if (summaryPassInFlight.has(conversationId)) {
    console.log(`[summary] Pasada ya en curso para conv ${conversationId} — omitiendo`);
    return;
  }
  summaryPassInFlight.add(conversationId);
  try {
    const conv = convRepo.findById(conversationId);
    if (!conv) return;

    // Los resúmenes usan SIEMPRE el provider principal: son la memoria a largo
    // plazo de la historia y su calidad importa. El fast LLM solo está presente
    // en pruebas locales — en producción (VPS) no existe, y desviar los resúmenes
    // a él haría que la calidad de la crónica dependiera del entorno.

    // Bloques globales: la comprobación es barata (no-op salvo que un bloque se
    // haya completado), así que se ejecuta en todos los turnos.
    await generateBlockSummaries(conversationId, provider, modelId, branchId);

    // El resumen personal por personaje sigue siendo rodante (ventana de 6 msgs).
    if (characterForPersonalSummary && conv.messageCount % SUMMARY_EVERY_N === 0) {
      await generateCharacterSummary(conversationId, provider, modelId, characterForPersonalSummary);
    }
  } catch (err) {
    // Summary update is non-critical — log and continue
    console.error('[summary] Error updating summary:', err);
  } finally {
    summaryPassInFlight.delete(conversationId);
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
    if (result) recordBgUsage(conv.id, 'hilo-fatal', (result as import('@rpgspeak/shared').GenerateResponse).tokens);
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
