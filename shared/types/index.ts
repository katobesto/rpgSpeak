// ─── User / Auth Types ────────────────────────────────────────────────────────

export type UserRole = 'admin' | 'user';

export type NarrationStyle = 'normal' | 'medium' | 'short';

export interface User {
  id: string;
  username: string;
  displayName: string;
  appearance: string;      // visual description used for image generation
  avatar: string | null;   // path to profile photo, e.g. /images/users/{id}/avatar.jpg
  role: UserRole;
  isActive: boolean;
  narrationStyle: NarrationStyle;
  createdAt: string;
  updatedAt: string;
}

export interface AuthPayload {
  userId: string;
  username: string;
  role: UserRole;
  displayName: string;
  appearance?: string;
}

export interface LoginRequest {
  username: string;
  password: string;
}

export interface LoginResponse {
  token: string;
  user: User;
}

export type CreateUserDto = {
  username: string;
  password: string;
  displayName: string;
  appearance?: string;
  role: UserRole;
};

export type UpdateUserDto = Partial<CreateUserDto>;

// ─── Core Domain Types ────────────────────────────────────────────────────────

export interface RpgStats {
  class?: string;
  level?: number;
  hp?: number;
  maxHp?: number;
  stats?: Record<string, number>;
  abilities?: string[];
  inventory?: string[];
  notes?: string;
}

/**
 * Ficha del JUGADOR (no de un Character) — misma forma que `RpgStats`, sin
 * duplicar estructura: el jugador puede llevar un mago en una campaña y un
 * guerrero en otra, así que vive POR CONVERSACIÓN en
 * `conversation.metadata.playerSheet`, no en el usuario.
 *
 * `hp` aquí es solo el punto de partida/nivel — el HP EN VIVO sigue teniendo
 * una única fuente de verdad: `PartyState` (ya usado por el minijuego de
 * combate), igual que ya ocurre con los personajes del grupo.
 */
export type PlayerSheet = RpgStats;

/**
 * Resultado de una tirada [TIRADA:...] resuelta por el servidor. Persistido en
 * `message.metadata.diceRoll` para que el cliente pinte el dado, y devuelto en
 * el evento `done` para que el store dispare la narración del desenlace.
 */
export interface DiceRollResult {
  who: string;
  attribute: string;
  cd: number;
  description: string;
  natural: number;
  modifier: number;
  total: number;
  success: boolean;
  critical: 'success' | 'failure' | null;
}

export interface Character {
  id: string;
  userId: string | null;
  ownerName: string | null;   // display name of the creator, resolved server-side
  storyIds: string[];          // IDs of stories this character is linked to (read-only, computed server-side)
  name: string;
  avatar: string | null;
  description: string;
  personality: string;
  systemPrompt: string;
  lore: string;
  exampleDialogue: ExampleDialoguePair[];
  tags: string[];
  temperature: number;
  modelId: string | null;
  providerId: string | null;
  contextLength: number;
  memoryEnabled: boolean;
  memoryType: 'rolling' | 'summary' | 'none';
  memoryWindow: number;
  llmParams: LLMParams;
  relations: CharacterRelation[];
  rpgStats: RpgStats;
  imageDescription: string | null;
  gallery: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ExampleDialoguePair {
  user: string;
  assistant: string;
}

export interface CharacterRelation {
  characterId: string;
  relationshipType: string;
  description: string;
}

export interface LLMParams {
  topP?: number;
  topK?: number;
  repetitionPenalty?: number;
  presencePenalty?: number;
  maxTokens?: number;
  stopSequences?: string[];
  seed?: number;
  [key: string]: unknown;
}

// ─── Story Types ──────────────────────────────────────────────────────────────

export interface Story {
  id: string;
  userId: string | null;
  ownerName: string | null;   // display name of the creator, resolved server-side
  name: string;
  description: string;
  globalContext: string;
  narrativeRules: string;
  worldLore: string;
  persistentEvents: StoryEvent[];
  locations: StoryLocation[];
  stateVariables: Record<string, string | number | boolean>;
  behaviorRestrictions: string[];
  isActive: boolean;
  adventureMode: boolean;
  /** true = mundo abierto: el narrador puede crear ubicaciones nuevas coherentes con el mundo;
   *  false = mapa cerrado: solo existen las ubicaciones definidas en la historia */
  openWorld: boolean;
  /** Modo "Regreso después de la muerte": el jugador puede morir en situaciones
   *  letales; al morir, la interfaz ofrece rebobinar la historia (máx. 20
   *  mensajes) y la IA fuerza la repetición del hilo fatal hasta superarlo. */
  deathMode: boolean;
  /** Calendario del mundo para la cabecera ambiental (fecha, estación, luna).
   *  null = calendario gregoriano real (ver GREGORIAN_CALENDAR). */
  calendar: StoryCalendar | null;
  characters: StoryCharacterLink[];
  createdAt: string;
  updatedAt: string;
}

// ─── Calendario del mundo y estado ambiental ──────────────────────────────────
//
// El tiempo de la partida se guarda como UN solo número (`minutesElapsed` en
// WorldState) y TODO lo demás — fecha, día de la semana, estación, fase lunar —
// se DERIVA de él en el servidor. Los modelos calculan mal la aritmética de
// fechas ("07:27 + 3h20m un lunes 14 de Kythorn") y derivan turno a turno; con
// un contador y una función pura, la cabecera nunca se contradice.

export interface StoryCalendar {
  /** Nombre informativo ("Calendario de Harptos"). */
  name: string;
  /** Nombres de los meses, en orden. */
  months: string[];
  /** Días de cada mes. Un solo elemento = se aplica a todos los meses. */
  daysPerMonth: number[];
  /** Nombres de los días de la semana, en orden. */
  weekdays: string[];
  /** Estación de cada mes (misma longitud que `months`). */
  seasons: string[];
  /** Duración del ciclo lunar en días. */
  moonCycleDays: number;
  /** Momento en que arranca la campaña (t=0). */
  startYear: number;
  /** Índice 0-based dentro de `months`. */
  startMonth: number;
  /** Día del mes, 1-based. */
  startDay: number;
  /** Minuto del día en t=0 (0..1439). */
  startMinuteOfDay: number;
  /** Índice dentro de `weekdays` en t=0. */
  startWeekdayIndex: number;
  /** Día del ciclo lunar en t=0 (0..moonCycleDays-1). */
  startMoonDay: number;
}

/** Estado ambiental de la conversación, persistido en `conversation.metadata.worldState`. */
export interface WorldState {
  /** Minutos transcurridos desde el inicio de la campaña. Única fuente de verdad temporal. */
  minutesElapsed: number;
  /** Clima actual, texto corto ("Brisa suave", "Llovizna fría"). */
  weather: string;
  /**
   * false mientras la escena no se haya anclado a la narrativa.
   *
   * Existe por un fallo concreto: sembrar el reloj a cero en una conversación
   * que ya llevaba cientos de mensajes producía una cabecera que contradecía
   * abiertamente lo narrado (decía «Cafetería, 08:00 AM» mientras el texto
   * describía a los personajes en la cama de noche). Sin anclar no se imprime
   * cabecera: se le pide al modelo que declare la escena, y sólo entonces
   * empieza el registro. Una cabecera falsa es peor que ninguna.
   */
  established: boolean;
  updatedAt: string;
}

/** Calendario real. Por defecto cuando la historia no define uno propio.
 *  Febrero fijo a 28 días: los años bisiestos no aportan nada narrativo y
 *  complicarían la aritmética con casos especiales por año. */
export const GREGORIAN_CALENDAR: StoryCalendar = {
  name: 'Calendario gregoriano',
  months: ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
           'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'],
  daysPerMonth: [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31],
  weekdays: ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'],
  seasons: ['Invierno', 'Invierno', 'Primavera', 'Primavera', 'Primavera', 'Verano',
            'Verano', 'Verano', 'Otoño', 'Otoño', 'Otoño', 'Invierno'],
  moonCycleDays: 28,
  startYear: 2024, startMonth: 2, startDay: 1,
  startMinuteOfDay: 8 * 60, startWeekdayIndex: 4, startMoonDay: 0,
};

/** Calendario de Harptos (Reinos Olvidados). 12 meses de 30 días; se omiten los
 *  días intercalares (Festival de la Luna, Solsticio…) por simplicidad. */
export const HARPTOS_CALENDAR: StoryCalendar = {
  name: 'Calendario de Harptos',
  months: ['Hammer', 'Alturiak', 'Ches', 'Tarsakh', 'Mirtul', 'Kythorn',
           'Flamerule', 'Eleasis', 'Eleint', 'Marpenoth', 'Uktar', 'Nightal'],
  daysPerMonth: [30],
  weekdays: ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'],
  seasons: ['Invierno', 'Invierno', 'Primavera', 'Primavera', 'Primavera', 'Primavera',
            'Verano', 'Verano', 'Otoño', 'Otoño', 'Otoño', 'Invierno'],
  moonCycleDays: 30,
  startYear: 1492, startMonth: 5, startDay: 14,
  startMinuteOfDay: 7 * 60 + 27, startWeekdayIndex: 0, startMoonDay: 15,
};

export const CALENDAR_PRESETS: StoryCalendar[] = [GREGORIAN_CALENDAR, HARPTOS_CALENDAR];

/** Valores derivados de `minutesElapsed` + calendario. Todo se calcula, nada se guarda. */
export interface WorldClock {
  /** "Madrugada" | "Mañana" | "Mediodía" | "Tarde" | "Anochecer" | "Noche" */
  timeOfDay: string;
  /** "07:27 AM" */
  time: string;
  /** "Lunes, 14 de Kythorn, 1492" */
  date: string;
  /** "Luna Llena" */
  moonPhase: string;
  /** "Primavera" */
  season: string;
  weather: string;
}

// ─── Death Loop (modo "Regreso después de la muerte") ─────────────────────────

/** Estado del bucle de muerte, persistido en conversation.metadata.deathLoop.
 *  null/ausente = sin bucle activo. */
export interface DeathLoopState {
  /** 'dead' = el jugador acaba de morir y la UI ofrece rebobinar;
   *  'looping' = línea temporal rebobinada, la IA repite el hilo fatal. */
  status: 'dead' | 'looping';
  /** Nº total de muertes en el bucle actual (≥1). */
  deathCount: number;
  /** Mensaje assistant donde se narró la última muerte (solo status 'dead'). */
  deathMessageId?: string;
  /** Retroceso solicitado por la IA para la última muerte (1-20 mensajes). */
  rewindDepth?: number;
  /** Ancla del bucle: mensaje al que se rebobina. Se fija en el primer regreso
   *  y se reutiliza en muertes posteriores del mismo bucle. */
  anchorMessageId?: string;
  /** Hilo narrativo de la secuencia fatal — lo que la IA debe hacer repetir. */
  threadSummary?: string;
  /** Causa breve de la última muerte (la emite la IA en la etiqueta). */
  lastDeathCause?: string;
}

export interface StoryEvent {
  id: string;
  title: string;
  description: string;
  trigger: string;   // What triggers this event (optional, may be empty string)
  /** Dónde ocurre el evento (nombre de ubicación, texto libre; opcional).
   *  Permite al narrador GUIAR al jugador hacia el lugar del evento en vez de
   *  esperar pasivamente a que el disparador se cumpla. */
  location?: string;
  timestamp: string;
  importance: number;
}

export interface StoryLocation {
  id: string;
  name: string;
  description: string;
  contents: string;
  exits: string;
  atmosphere: string;
}

export interface StoryCharacterLink {
  characterId: string;
  role: string;
  notes: string;
}

// ─── Conversation Types ───────────────────────────────────────────────────────

export interface Conversation {
  id: string;
  title: string;
  summary: string | null;
  /** Current scene location — updated automatically when the LLM emits [UBICACION:...] */
  currentLocation: string | null;
  mode: 'single' | 'group' | 'story';
  activeCharacterId: string | null;
  isArchived: boolean;
  tokenCount: number;
  messageCount: number;
  characters: ConversationCharacterLink[];
  stories: ConversationStoryLink[];
  metadata: Record<string, unknown>;
  userId: string | null;
  ownerName: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationCharacterLink {
  characterId: string;
  order: number;
  affinity: number;
}

export interface ConversationStoryLink {
  storyId: string;
  priority: number;
}

// ─── Message Types ────────────────────────────────────────────────────────────

export interface Message {
  id: string;
  conversationId: string;
  parentId: string | null;
  branchId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  characterId: string | null;
  tokens: number;
  isActive: boolean;
  metadata: MessageMetadata;
  createdAt: string;
  updatedAt: string;
}

export interface MessageMetadata {
  model?: string;
  provider?: string;
  generationTime?: number;
  isStreaming?: boolean;
  promptTokens?: number;
  completionTokens?: number;
  cachedTokens?: number;
  sceneImageUrl?: string;
  sceneImagePending?: boolean;  // true mientras el upscale 4K sigue procesando
  /** Paso EN CURSO del enriquecimiento de fondo (director de escena, resúmenes…)
   *  tras generar esta respuesta. Ausente = sin ninguno pendiente / ya terminado. */
  enrichStep?: { index: number; total: number; label: string };
  /** Tirada [TIRADA:...] resuelta por el servidor para ESTE mensaje, si pidió una. */
  diceRoll?: DiceRollResult;
  [key: string]: unknown;
}

// ─── Memory Types ─────────────────────────────────────────────────────────────

export interface MemoryEntry {
  id: string;
  conversationId: string;
  characterId: string | null;
  type: 'fact' | 'event' | 'relationship' | 'preference' | 'summary' | 'offense' | 'trauma';
  content: string;
  importance: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

// ─── Provider Types ───────────────────────────────────────────────────────────

export type ProviderType = 'ollama' | 'openai' | 'lmstudio' | 'mlx' | 'kobold' | 'oobabooga' | 'openrouter' | 'custom';

export interface Provider {
  id: string;
  name: string;
  type: ProviderType;
  baseUrl: string;
  apiKey: string | null;
  defaultModel: string | null;
  isEnabled: boolean;
  config: ProviderConfig;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderConfig {
  timeout?: number;
  maxRetries?: number;
  headers?: Record<string, string>;
  [key: string]: unknown;
}

export interface ProviderModel {
  id: string;
  name: string;
  contextLength?: number;
  description?: string;
  /** Precio por millón de tokens de ENTRADA (prompt), en USD. Solo si la API lo expone (OpenRouter). */
  promptPricePerM?: number;
  /** Precio por millón de tokens de SALIDA (completion), en USD. */
  completionPricePerM?: number;
  /** Máx. tokens de salida admitidos por el proveedor top de este modelo. */
  maxCompletionTokens?: number;
  /** El modelo admite razonamiento/thinking (supported_parameters incluye "reasoning"). */
  supportsReasoning?: boolean;
  /** Modalidades de entrada, p.ej. ["text","image"] (architecture.input_modalities). */
  inputModalities?: string[];
  /** Tokenizer / familia del modelo (architecture.tokenizer). */
  tokenizer?: string;
  /** Propietario / organización del modelo (owned_by). */
  ownedBy?: string;
  /** Fecha de alta del modelo (epoch en segundos), si la API la expone. */
  created?: number;
}

// ─── Scene Image ─────────────────────────────────────────────────────────────

export interface SceneImage {
  url: string;
  pending?: boolean;
  /** Internal token to identify the generation task and detect superseded results */
  token?: string;
  description?: string;
}

// ─── Background Image (per-conversation) ──────────────────────────────────────

export interface BackgroundImage {
  id: string;
  url: string;
  prompt: string;
  width: number;
  height: number;
  createdAt: string;
}

export interface ConversationBackground {
  url: string;
  prompt?: string;
  /** 0-1, visibilidad de la imagen de fondo; default 1 */
  opacity?: number;
}

// ─── Party State (combate persistente) ─────────────────────────────────────

export interface PartyMemberState {
  id: string;
  name: string;
  hp: number;
  maxHp: number;
  energy: number;
  maxEnergy: number;
}

export interface PartyInventoryItemState {
  id: string;
  name: string;
  quantity: number;
}

export interface PartyState {
  members: PartyMemberState[];
  inventory: PartyInventoryItemState[];
  xp: number;
  gold: number;
  updatedAt: string;
}

export interface BackgroundAspectRatio {
  id: string;
  label: string;
  width: number;
  height: number;
}

export const BACKGROUND_ASPECT_RATIOS: BackgroundAspectRatio[] = [
  { id: '1:1',  label: 'Cuadrado (1:1)',    width: 1024, height: 1024 },
  { id: '16:9', label: 'Panorámico (16:9)', width: 1344, height: 768 },
  { id: '9:16', label: 'Vertical (9:16)',   width: 768,  height: 1344 },
  { id: '4:3',  label: 'Estándar (4:3)',    width: 1152, height: 896 },
  { id: '3:4',  label: 'Retrato (3:4)',     width: 896,  height: 1152 },
];

// ─── TTS Types ────────────────────────────────────────────────────────────────

export interface TtsTextReplacement {
  /** Texto a buscar (sin distinguir mayúsculas) */
  search:  string;
  /** Texto con el que se sustituye */
  replace: string;
}

export interface TtsSettings {
  /** Enable the TTS feature across the app */
  enabled: boolean;
  /** ID of the default voice from the catalog (e.g. "edge_elvira") */
  defaultVoiceId: string | null;
  /** Playback speed multiplier — 0.5 (slow) to 2.0 (fast) */
  speed: number;
  /** Generation temperature — 0.1 (stable) to 1.0 (expressive) */
  temperature: number;
  /** Automatically play TTS for new AI messages */
  autoPlay: boolean;
  /** Lista de sustituciones de texto para mejorar la pronunciación */
  replacements: TtsTextReplacement[];
}

export interface TtsVoice {
  id: string;
  name: string;
  gender: 'male' | 'female';
  description: string;
  type: 'cloud' | 'local';
  /** Populated by API — whether the voice is ready to use */
  available?: boolean;
}

// ─── Settings Types ───────────────────────────────────────────────────────────

export interface AppSettings {
  theme: 'dark' | 'light' | 'system';
  accentColor: string;
  fontSize: 'sm' | 'md' | 'lg';
  sendOnEnter: boolean;
  showTimestamps: boolean;
  showTokenCount: boolean;
  defaultProviderId: string | null;
  defaultModelId: string | null;
  globalSystemPrompt: string;
  responseFormatPrompt: string;
  narratorPrompt: string;
  affinitySystemPrompt: string;
  // Coherencia del personaje — se inyecta pegado al mensaje del usuario (footer)
  // para máxima autoridad en conversaciones largas. Consolida integridad,
  // opinión propia, decir "no" y firmeza de valores/límites.
  characterCoherencePrompt: string;
  // Mundo vivo / Teoría de la Mente — directiva maestra que hace que CADA personaje
  // o PNJ (incluidos guardias, tenderos y desconocidos sin ficha) razone desde lo
  // que realmente sabe y siente, y no se rinda a los deseos del jugador. Se inyecta
  // en el footer de forma incondicional (a diferencia de characterCoherencePrompt,
  // que depende de que haya afinidades registradas).
  livingWorldPrompt: string;
  contextStrategy: 'rolling' | 'summary' | 'hybrid';
  maxContextMessages: number;
  autoSummarizeThreshold: number;
  maxResponseTokens: number | null;  // null = sin límite (deja decidir al modelo)
  defaultContextLength: number;       // ventana de contexto de entrada por defecto
  // Tono de respuesta del LLM (temperatura de muestreo). Global; manda sobre el
  // valor por personaje. Ignorada por modelos en modo thinking (p.ej. DeepSeek).
  generationTemperature: number;      // ~0.4 preciso · ~0.7 equilibrado · ~1.0 expresivo
  // Parámetros avanzados de muestreo — global, mandan sobre character.llmParams.
  // Ignorados por modelos en modo thinking, igual que la temperatura.
  generationTopP: number;             // 1.0 = sin recorte (default OpenAI-compatible)
  /** Penaliza tokens PROPORCIONALMENTE a cuántas veces ya se repitieron — reduce
   *  muletillas y elogios reiterados ("me regalaste…", "eres increíble…"). 0 = off. */
  generationFrequencyPenalty: number;
  /** Penaliza con un castigo FIJO cualquier token ya usado en el contexto — empuja
   *  a no reciclar el mismo vocabulario de evasivas ("no lo sé", "quizá"). 0 = off. */
  generationPresencePenalty: number;
  streamingEnabled: boolean;
  layoutMode: 'default' | 'compact' | 'wide';
  sidebarPosition: 'left' | 'right';
  ttsSettings: TtsSettings;
  comfyUiUrl: string;
  sceneImagePrompt: string;
  charImagePrompt: string;
  backgroundImagePrompt: string;
  // Image generation provider
  imageProvider: 'comfyui' | 'pollinations' | 'gemini' | 'fal' | 'bzcomfy';
  imageProviderApiKey: string | null;        // API key for Gemini / Fal
  pollinationsModel: string | null;          // Model for Pollinations
  geminiModel: string | null;               // Model for Gemini
  falModel: string | null;                  // Model/endpoint for Fal.ai
  // bzComfy — remote ComfyUI proxy (Machine-to-Machine via Bearer token)
  bzComfyUrl: string;
  bzComfyApiToken: string | null;
  bzComfyWorkflow: string;
  // LLM Rápido de apoyo
  fastLlmEnabled: boolean;
  fastLlmProviderId: string | null;
  fastLlmModelId: string | null;
  fastLlmDebugMode: boolean;
  fastLlmAnalysisPrompt: string;
  // Inyección de memoria en el contexto del LLM principal
  memoryInjectionPrompt: string;
  // Embeddings semánticos para el Índice de Contexto
  embeddingEnabled:    boolean;
  embeddingProviderId: string | null;
  embeddingModel:      string | null;   // e.g. "nomic-embed-text"
  // Inyección del Índice de Contexto en el LLM
  contextIndexInjectionEnabled:  boolean;
  contextIndexInjectionMaxItems: number;
  contextIndexInjectionPrompt:   string;
  // Prompt de extracción de contexto (Índice de Contexto)
  contextIndexPrompt: string;
  // Ventana de contexto (tokens) para la llamada de extracción
  contextIndexContextSize: number;
  // Auto-extracción del Índice de Contexto (se ejecuta en background tras cada respuesta)
  contextAutoExtractEnabled:    boolean;
  contextAutoExtractInterval:   number;        // cada N mensajes nuevos (default 8)
  contextAutoExtractProviderId: string | null; // null = usar fast LLM o default
  contextAutoExtractModelId:    string | null;
  // Generación de eventos de historia
  storyEventGenerationPrompt: string;
  // Generación de ubicaciones de historia
  storyLocationGenerationPrompt: string;
  // Asistente de historias — genera historia completa + personajes a partir de un briefing
  storyAssistantPrompt: string;
  // Estilo de narración — prompts inyectados cuando el usuario elige Medium o Short
  narrationMediumPrompt: string;
  narrationShortPrompt:  string;
  // Moderación de contenido
  allowNsfw: boolean;
  nsfwBlockedMessage: string;
  // Resúmenes de sucesos — longitud máxima de cada resumen generado (en frases aprox.)
  summaryMaxLength: number;
  // Resúmenes por bloques — tamaño del bloque en mensajes. Cada bloque completado
  // se resume UNA vez desde los mensajes crudos (inmutable); en el prompt se
  // inyectan solo los bloques anteriores a la ventana de historial vivo.
  summaryBlockSize: number;
  // Opciones de API
  disableFallbacks: boolean;
  // Thinking / razonamiento (DeepSeek V4 y modelos compatibles con `thinking`)
  reasoningEnabled: boolean;
  reasoningEffort: 'high' | 'max';
  // Cloudflare Access — para proteger ComfyUI remoto tras un túnel
  comfyUiCfClientId: string | null;
  comfyUiCfClientSecret: string | null;
}

// ─── API Response Types ───────────────────────────────────────────────────────

export interface ApiResponse<T> {
  data: T;
  success: true;
}

export interface ApiError {
  error: string;
  message: string;
  statusCode: number;
  success: false;
}

export type ApiResult<T> = ApiResponse<T> | ApiError;

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

// ─── LLM Generation Types ─────────────────────────────────────────────────────

export interface GenerateRequest {
  messages: ChatMessage[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  contextSize?: number;   // ventana de contexto total para el proveedor (input + output)
  topP?: number;
  topK?: number;
  repetitionPenalty?: number;
  presencePenalty?: number;
  stopSequences?: string[];
  stream: boolean;
  /** When true, adds allow_fallbacks:false to OpenAI-compatible requests (e.g. OpenRouter). */
  disableFallbacks?: boolean;
  /** Enables `thinking` mode on supporting models (e.g. DeepSeek V4). */
  reasoning?: { enabled: boolean; effort?: 'high' | 'max'; expose?: boolean };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface GenerateResponse {
  content: string;
  model: string;
  tokens: {
    prompt: number;
    completion: number;
    total: number;
    cached?: number;  // tokens served from prompt cache (OpenAI / DeepSeek)
  };
  finishReason: string;
}

// ─── Streaming Types ──────────────────────────────────────────────────────────

export interface AffinityUpdate {
  characterId: string;
  newAffinity: number;
  previousAffinity?: number;
}

export interface StreamChunk {
  type: 'token' | 'done' | 'error';
  token?: string;
  messageId?: string;
  error?: string;
  metadata?: GenerateResponse;
  affinityUpdates?: AffinityUpdate[];
  /** True when the completed message was generated in narrator mode */
  narrator?: boolean;
  /** The characterId stored on the persisted message (null for narrator) */
  characterId?: string | null;
  /** New location emitted by the LLM via [UBICACION:...] — null if cleared, undefined if unchanged */
  locationUpdate?: string | null;
}

// ─── Conversation Summary Types ───────────────────────────────────────────────

export interface ConversationSummary {
  id: string;
  conversationId: string;
  content: string;
  messageIndexFrom: number;
  messageIndexTo: number;
  createdAt: string;
  /** 'block'  = bloque automático inmutable (se inyecta en el prompt);
   *  'arc'    = resumen de arco: condensa ~4 bloques antiguos consecutivos — el
   *             nivel superior de la pirámide (pasado lejano, más comprimido);
   *  'manual' = generado por el usuario desde la UI (solo informativo). */
  kind: 'block' | 'manual' | 'arc';
}

// ─── Context Index Types ──────────────────────────────────────────────────────

export type ContextItemType = 'event' | 'character' | 'place' | 'quest';

export interface ContextItem {
  id: string;
  conversationId: string;
  type: ContextItemType;
  title: string;
  description: string;
  importance: number;       // 1-10
  messageIndexFrom: number; // inclusive start of batch (0-based, non-system msgs)
  messageIndexTo: number;   // exclusive end of batch
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

// ─── Hilos narrativos ─────────────────────────────────────────────────────────
//
// La deuda narrativa viva de una partida: la promesa hecha, la pregunta que un
// personaje esquivó, el desconocido que los seguía, la amenaza latente.
//
// Existe porque nada más lo sostenía. Los eventos de historia (`StoryEvent`) son
// guion escrito de antemano; las memorias son hechos ya consumados; el resumen
// comprime. Lo que EMERGE jugando y queda sin resolver no vivía en ninguna
// estructura, así que al salir de la ventana de historial dejaba de existir —
// la causa directa de que las situaciones se diluyan en sesiones largas.
export interface NarrativeThread {
  id: string;
  conversationId: string;
  /** Título corto; es también la clave por la que el LLM lo cierra. */
  title: string;
  description: string;
  status: 'open' | 'closed';
  importance: number;        // 1-10
  /** messageCount de la conversación al abrirse — permite mostrar su antigüedad. */
  openedAtIndex: number;
  closedAtIndex: number | null;
  createdAt: string;
  updatedAt: string;
}

// ─── Director de escena ───────────────────────────────────────────────────────
//
// El estado que hace que un personaje sea una persona y no una ficha: qué quiere
// AHORA, qué le preocupa, qué tiene pendiente con el jugador y qué se llevó del
// último encuentro. Los prompts lo pedían («cada uno llega con un estado de
// ánimo…») pero no existía ningún dato que lo instanciara, así que el modelo lo
// improvisaba de cero cada turno y rellenaba con lo genérico.
//
// Lo mantiene una llamada dedicada en segundo plano (LLM principal) — NO
// etiquetas emitidas en mitad de la narración: ese patrón se probó con el
// anclaje de escena y el modelo lo ignoraba sistemáticamente.

/** Estado interno de un personaje con ficha, dentro de la conversación. */
export interface CharacterSceneState {
  /** Objetivo inmediato: qué quiere conseguir en esta escena o etapa. */
  quiere: string;
  /** Tensión interna: qué le preocupa o le pesa ahora mismo. */
  preocupa: string;
  /** Lo no resuelto con el jugador: lo que no ha dicho, lo que espera de él. */
  pendiente: string;
  /** Qué se llevó del último encuentro con el jugador. */
  impresion: string;
}

/** PNJ sin ficha (un guardia, un tendero) con continuidad entre escenas. */
export interface NpcSceneState {
  nombre: string;
  /** Rasgo dominante en una línea — lo que lo hace él y no otro. */
  rasgo: string;
  /** Estado emocional actual (paranoico y en alerta, jovial, harto…). */
  estado: string;
  /** true si ya ha interactuado con el jugador — si no, no lo conoce de nada. */
  conoceAlJugador: boolean;
}

/** Estado completo del director de escena, en conversation.metadata.sceneState. */
export interface SceneDirectorState {
  /** Qué está pasando AHORA y qué está en juego (1-2 frases). */
  situacion: string;
  /** Nivel de tensión de la escena + causa breve. */
  tension: string;
  /** Estado interno por characterId. */
  characters: Record<string, CharacterSceneState>;
  npcs: NpcSceneState[];
  /** Índice de mensaje en el que se actualizó — controla la cadencia. */
  updatedAtIndex: number;
  updatedAt: string;
}

export interface ContextExtractResult {
  items: ContextItem[];
  batchStart: number;
  batchEnd: number;
  totalMessages: number;
}

// ─── DTO Types (for API input) ────────────────────────────────────────────────

export type CreateCharacterDto = Omit<Character, 'id' | 'userId' | 'ownerName' | 'storyIds' | 'createdAt' | 'updatedAt'>;
export type UpdateCharacterDto = Partial<CreateCharacterDto>;

// `calendar` se marca opcional: el servidor lo tiene con default null (ver
// story.schema.ts), así que un cliente que no lo envíe obtiene el gregoriano.
export type CreateStoryDto =
  Omit<Story, 'id' | 'userId' | 'ownerName' | 'createdAt' | 'updatedAt' | 'calendar'> &
  { calendar?: StoryCalendar | null };
export type UpdateStoryDto = Partial<CreateStoryDto>;

// ─── Story Assistant Types ────────────────────────────────────────────────────

/** Una pista de personaje proporcionada por el usuario en el cuestionario.
 *  Cualquier campo vacío lo completa el LLM. */
export interface StoryAssistantCharacterHint {
  name: string;   // sugerencia de nombre ('' = que lo invente la IA)
  notes: string;  // características aproximadas / rol deseado
}

/** Briefing que el usuario rellena en el wizard antes de generar la historia. */
export interface StoryAssistantBriefing {
  theme: string;          // temática / premisa (obligatorio)
  genre: string;          // género (opcional)
  tone: string;           // tono (opcional)
  /** Ritmo de la historia: 1 = muy pausado/contemplativo … 5 = muy rápido/frenético. */
  pacing: number;
  numCharacters: number;  // cuántos personajes generar
  numEvents: number;      // cuántos eventos persistentes generar
  numLocations: number;   // cuántas ubicaciones generar
  adventureMode: boolean;
  openWorld: boolean;
  characterHints: StoryAssistantCharacterHint[];
  extra: string;          // notas libres adicionales
}

/** Borrador de personaje devuelto por el asistente (antes de crearlo en la BD). */
export interface StoryAssistantCharacterDraft {
  name: string;
  role: string;        // rol dentro de la historia (se guarda en el vínculo)
  description: string;
  personality: string;
  lore: string;
  tags: string[];
}

/** Resultado de la generación del asistente: borradores listos para previsualizar. */
export interface StoryAssistantResult {
  story: {
    name: string;
    description: string;
    globalContext: string;
    worldLore: string;
    narrativeRules: string;
    events: Omit<StoryEvent, 'id' | 'timestamp'>[];
    locations: Omit<StoryLocation, 'id'>[];
  };
  characters: StoryAssistantCharacterDraft[];
}

export type CreateConversationDto = {
  title?: string;
  mode?: Conversation['mode'];
  characterIds?: string[];
  storyIds?: string[];
};
export type UpdateConversationDto = Partial<Pick<Conversation, 'title' | 'activeCharacterId' | 'isArchived'>>;

export type CreateMessageDto = {
  role: Message['role'];
  content: string;
  characterId?: string;
  parentId?: string;
};

export type CreateProviderDto = Omit<Provider, 'id' | 'createdAt' | 'updatedAt'>;
export type UpdateProviderDto = Partial<CreateProviderDto>;

export type UpdateSettingsDto = Partial<AppSettings>;

/** A single LoRA slot inside a "Power Lora Loader (rgthree)" node. */
export interface BzPowerLora {
  /** Input key on the Power Lora Loader node, e.g. "lora_4". */
  key: string;
  /** LoRA filename. */
  name: string;
  /** Whether the LoRA is currently enabled in the workflow. */
  on: boolean;
  /** LoRA strength (model + clip). */
  strength: number;
}

/** Base-model selector exposed by a workflow (e.g. UNETLoader checkpoint choice). */
export interface BzModelControl {
  label: string;
  defaultModel: string | null;
  options: string[];
}

export interface BzWorkflow {
  id: string;
  label: string;
  hasImageInput: boolean;
  imageInputLabel: string | null;
  hasLora?: boolean;
  /** True when the workflow contains a FluxResolutionNode (megapixel + aspect_ratio controls). */
  hasResolutionControl?: boolean;
  /** Default megapixel value read from the workflow's FluxResolutionNode. */
  defaultMegapixel?: string;
  /** Default aspect_ratio value read from the workflow's FluxResolutionNode. */
  defaultAspectRatio?: string;
  /** True when the workflow exposes a base-model selector (e.g. UNETLoader). */
  hasModelControl?: boolean;
  modelControl?: BzModelControl | null;
  /** True when the workflow contains a "Power Lora Loader (rgthree)" node. */
  hasPowerLora?: boolean;
  powerLoras?: BzPowerLora[];
}

// ─── Resolución tolerante de nombres de personaje ────────────────────────────
// Los modelos mencionan a los personajes de forma laxa en el texto libre: sueltan
// el artículo ("Conserje" por "El conserje"), usan solo el nombre de pila ("Yumi"
// por "Yumi Kanzaki") o añaden énfasis markdown. Un emparejado exacto descartaba
// esas menciones en silencio → etiquetas [AFINIDAD] perdidas y avatares del que
// habla sin foto. Esta utilidad centraliza la resolución para todos esos usos.

/** Minúsculas, sin markdown ni artículo inicial en español. */
export function normalizeCharacterName(s: string): string {
  return s
    .toLowerCase()
    .replace(/[*_`~]/g, '')
    .replace(/^(el|la|los|las|un|una)\s+/i, '')
    .trim();
}

/**
 * Empareja un nombre mencionado en texto con uno de los personajes dados.
 * Estrategias, de más a menos estricta (para en la primera que acierta):
 *   1. Exacto (case-insensitive).
 *   2. Normalizado: sin artículo inicial ni markdown ("Conserje" ↔ "El conserje").
 *   3. Primer token, SOLO si es inequívoco ("Yumi" ↔ "Yumi Kanzaki").
 * Devuelve el personaje o `undefined` si no hay match seguro (nunca adivina si es ambiguo).
 */
export function matchCharacterName<T extends { name: string }>(
  rawName: string,
  characters: readonly T[],
): T | undefined {
  const cleaned = rawName.replace(/[*_`~]/g, '').trim();
  if (!cleaned) return undefined;
  const lc = cleaned.toLowerCase();

  const exact = characters.find((c) => c.name.toLowerCase() === lc);
  if (exact) return exact;

  const norm = normalizeCharacterName(cleaned);
  if (!norm) return undefined;

  const normMatch = characters.find((c) => normalizeCharacterName(c.name) === norm);
  if (normMatch) return normMatch;

  const first = norm.split(/\s+/)[0];
  if (first) {
    const byFirst = characters.filter((c) => normalizeCharacterName(c.name).split(/\s+/)[0] === first);
    if (byFirst.length === 1) return byFirst[0];
  }
  return undefined;
}
