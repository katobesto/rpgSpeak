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
  timeline: TimelineEntry[];
  behaviorRestrictions: string[];
  isActive: boolean;
  adventureMode: boolean;
  characters: StoryCharacterLink[];
  createdAt: string;
  updatedAt: string;
}

export interface StoryEvent {
  id: string;
  title: string;
  description: string;
  trigger: string;   // What triggers this event (optional, may be empty string)
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

export interface TimelineEntry {
  id: string;
  label: string;
  description: string;
  order: number;
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
}

// ─── Scene Image ─────────────────────────────────────────────────────────────

export interface SceneImage {
  url: string;
  pending?: boolean;
  /** Internal token to identify the generation task and detect superseded results */
  token?: string;
  description?: string;
}

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
  adventurePrompt: string;
  affinitySystemPrompt: string;
  contextStrategy: 'rolling' | 'summary' | 'hybrid';
  maxContextMessages: number;
  autoSummarizeThreshold: number;
  maxResponseTokens: number | null;  // null = sin límite (deja decidir al modelo)
  defaultContextLength: number;       // ventana de contexto de entrada por defecto
  streamingEnabled: boolean;
  layoutMode: 'default' | 'compact' | 'wide';
  sidebarPosition: 'left' | 'right';
  ttsSettings: TtsSettings;
  comfyUiUrl: string;
  sceneImagePrompt: string;
  charImagePrompt: string;
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
  // Estilo de narración — prompts inyectados cuando el usuario elige Medium o Short
  narrationMediumPrompt: string;
  narrationShortPrompt:  string;
  // Moderación de contenido
  allowNsfw: boolean;
  nsfwBlockedMessage: string;
  // Resúmenes de sucesos — longitud máxima de cada resumen generado (en frases aprox.)
  summaryMaxLength: number;
  // Opciones de API
  disableFallbacks: boolean;
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
  stopSequences?: string[];
  stream: boolean;
  /** When true, adds allow_fallbacks:false to OpenAI-compatible requests (e.g. OpenRouter). */
  disableFallbacks?: boolean;
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
}

// ─── Conversation Summary Types ───────────────────────────────────────────────

export interface ConversationSummary {
  id: string;
  conversationId: string;
  content: string;
  messageIndexFrom: number;
  messageIndexTo: number;
  createdAt: string;
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

export interface ContextExtractResult {
  items: ContextItem[];
  batchStart: number;
  batchEnd: number;
  totalMessages: number;
}

// ─── DTO Types (for API input) ────────────────────────────────────────────────

export type CreateCharacterDto = Omit<Character, 'id' | 'userId' | 'ownerName' | 'storyIds' | 'createdAt' | 'updatedAt'>;
export type UpdateCharacterDto = Partial<CreateCharacterDto>;

export type CreateStoryDto = Omit<Story, 'id' | 'userId' | 'ownerName' | 'createdAt' | 'updatedAt'>;
export type UpdateStoryDto = Partial<CreateStoryDto>;

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

export interface BzWorkflow {
  id: string;
  label: string;
  hasImageInput: boolean;
  imageInputLabel: string | null;
  hasLora?: boolean;
}
