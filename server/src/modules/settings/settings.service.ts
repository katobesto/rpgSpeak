import { sql, eq } from 'drizzle-orm';
import { getDb } from '../../db/index.js';
import { settings } from '../../db/schema.js';
import type { AppSettings, TtsSettings } from '@rpgspeak/shared';
import { CONVERSATION_PROMPTS, resolveConversationPrompt } from './conversation-prompts.js';

const TTS_DEFAULTS: TtsSettings = {
  enabled:        false,
  defaultVoiceId: 'edge_elvira',
  speed:          1.0,
  temperature:    0.667,
  autoPlay:       false,
  replacements:   [],
};

const DEFAULTS: AppSettings = {
  theme: 'dark',
  accentColor: '#7c3aed',
  fontSize: 'md',
  sendOnEnter: true,
  showTimestamps: true,
  showTokenCount: false,
  defaultProviderId: null,
  defaultModelId: null,
  globalSystemPrompt: CONVERSATION_PROMPTS.globalSystemPrompt,
  responseFormatPrompt: CONVERSATION_PROMPTS.responseFormatPrompt,
  narratorPrompt: CONVERSATION_PROMPTS.narratorPrompt,
  characterCoherencePrompt: CONVERSATION_PROMPTS.characterCoherencePrompt,
  livingWorldPrompt: CONVERSATION_PROMPTS.livingWorldPrompt,
  affinitySystemPrompt: CONVERSATION_PROMPTS.affinitySystemPrompt,
  contextStrategy: 'rolling',
  // 40 → 60 (2026-07-23): más historial literal en la ventana viva es la vía más
  // directa a más realismo, y el usuario asume el coste en tokens. Si este valor
  // ya está personalizado en la BD, el default no aplica — se cambia en Ajustes.
  maxContextMessages: 60,
  autoSummarizeThreshold: 30,
  maxResponseTokens: null,       // null = sin límite
  defaultContextLength: 32768,   // ventana de contexto de entrada
  generationTemperature: 0.7,    // tono global (equilibrado); manda sobre el del personaje
  generationTopP: 1.0,               // sin recorte por defecto
  generationRepetitionPenalty: 1.1,  // multiplicativa; separada de frequency/presence
  generationFrequencyPenalty: 0,     // sin penalizar — penaliza por FRECUENCIA de token,
                                      // castigaría también nombres propios repetidos; no es la palanca correcta aquí
  // Toque ligero (2026-07-23): antes 0, sin ningún mecanismo anti-repetición en
  // todo el sistema. presencePenalty castiga reutilizar un token YA aparecido,
  // sin importar cuántas veces — más fino que frequencyPenalty para "no vuelvas
  // sobre el mismo tema/giro". 0.15 es un toque ligero, no un filtro agresivo.
  // NOTA: esto solo afecta a instalaciones NUEVAS — una fila ya existente en la
  // tabla settings de una instalación en marcha no se toca automáticamente.
  generationPresencePenalty: 0.15,
  streamingEnabled: true,
  layoutMode: 'default',
  sidebarPosition: 'left',
  ttsSettings: TTS_DEFAULTS,
  comfyUiUrl: 'http://127.0.0.1:8000',
  imageProvider: 'comfyui',
  bzComfyUrl: 'https://bzcomfy.javierbenzo.com',
  bzComfyApiToken: null,
  bzComfyWorkflow: '',
  imageProviderApiKey: null,
  pollinationsModel: 'flux',
  geminiModel: 'imagen-4.0-generate-001',
  falModel: 'fal-ai/flux/schnell',
  // LLM Rápido de apoyo
  fastLlmEnabled: false,
  fastLlmProviderId: null,
  fastLlmModelId: null,
  fastLlmPreAnalysisEnabled: true,
  fastLlmPostAnalysisEnabled: true,
  fastLlmDebugMode: false,
  fastLlmAnalysisPrompt: `Eres un analizador de juego de rol. Decides si algo merece ser recordado de forma permanente. Eres BRUTALMENTE selectivo: el 90% de los turnos deben producir NINGUNO.

PERSONAJES (ÚNICOS VÁLIDOS — no uses otros):
{{PERSONAJES}}

MENSAJE DEL JUGADOR: {{MENSAJE_JUGADOR}}
RESPUESTA DEL PERSONAJE: {{RESPUESTA}}

━━━ FILTRO ÚNICO ━━━

Responde esta pregunta antes de analizar nada:
"¿Cambiaría el comportamiento o las decisiones del personaje en la próxima sesión si no recordara esto?"

NO → NINGUNO. Sin más análisis.
SÍ → continúa solo si el evento aparece en la lista de abajo.

━━━ SIEMPRE ES NINGUNO ━━━

• Conversación, saludos, despedidas, preguntas cotidianas
• Exploración, viajes, descripciones de escenas, combate sin consecuencias permanentes
• El personaje expresa una opinión, gusto, preferencia o sentimiento (aunque sea importante para él)
• Reacción emocional pasajera que no deja huella física ni psicológica duradera
• Cualquier cosa deducible del contexto reciente o de la personalidad/trasfondo del personaje
• Intercambio que el personaje ya conocía o puede concluir sin haberlo recordado
• Importancia menor a 8: no existe nivel 7 — si en duda, es NINGUNO

━━━ CUÁNDO CREAR MEMORIA ━━━

Máximo 1 MEMORIA por turno. Solo en estos casos:

[evento, imp. 8-10] Objeto entregado y en posesión del personaje, herida o cicatriz, cambio físico permanente y concreto.
[evento, imp. 8-10] Salvó o puso en riesgo la vida del personaje de forma directa y deliberada.
[evento, imp. 8-9] Juramento solemne, promesa vinculante, o declaración explícita de amor u odio que cambia la dinámica de forma irreversible.
[ofensa, imp. 8-10] Violencia física directa al personaje, contacto íntimo no consentido, insulto grave o humillación pública deliberada.
[trauma, imp. 9-10] Daño psicológico profundo y duradero causado por el jugador (no una reacción pasajera).
[hecho, imp. 9-10] Secreto exclusivo del personaje revelado por primera vez, cuyo olvido cambiaría la dinámica de la relación.

PROHIBIDO: no uses los tipos "relacion" ni "preferencia".

━━━ AFINIDAD ━━━

Solo cambia si ocurrió algo de la lista anterior. Delta MÍNIMO ±5 — valores menores son ruido y no deben registrarse.

• Violencia / contacto no consentido / traición: -10 a -15 (SIEMPRE negativo, sin excepción)
• Insulto grave / humillación deliberada: -8 a -12
• Salvar la vida directamente / lealtad bajo presión extrema: +6 a +10
• Regalo de altísimo valor emocional / confesión de gran confianza correspondida: +5 a +8

El afecto y el romance suben DESPACIO: reserva los valores altos para hechos verdaderamente excepcionales. Un vínculo se construye con muchos momentos, no con uno — ante la duda, tira a la baja en los positivos.
La reacción externa del personaje NO importa — el impacto interno es real aunque lo disimule.
Si el jugador actúa con intención sexual o agresiva y la afinidad es < 80, el delta es NEGATIVO.

━━━ FORMATO ━━━

Sin nada que registrar:
NINGUNO

Con evento (solo si cumple todo lo anterior):
[MEMORIA:NombrePersonaje:tipo:importancia]descripción concisa en tercera persona, hechos concretos[/MEMORIA]
[AFINIDAD:NombrePersonaje:+N o -N]

TIPOS válidos: evento · hecho · ofensa · trauma`,
  // Embeddings semánticos para el Índice de Contexto
  embeddingEnabled:    false,
  embeddingProviderId: null,
  embeddingModel:      null,
  // Inyección del Índice de Contexto en el LLM. Activada por defecto junto con
  // la extracción de arriba — de nada sirve extraer si no se inyecta.
  contextIndexInjectionEnabled:  true,
  contextIndexInjectionMaxItems: 10,
  contextIndexInjectionPrompt: `## Índice de contexto — Estado del mundo

Los siguientes elementos del mundo, personajes y eventos son relevantes para este momento de la historia. Úsalos como referencia de fondo para mantener coherencia narrativa:

{{CONTEXTO}}

Ten en cuenta esta información al responder. No la menciones explícitamente salvo que el diálogo lo requiera.

Es información del MUNDO, no el conocimiento de cada personaje: úsala solo a través de quien la habría sabido. Un personaje no puede mencionar, reaccionar ni actuar según un dato de este índice si no estuvo presente cuando se estableció y nadie se lo contó en la historia.`,
  memoryInjectionPrompt: `## Hechos establecidos

Los siguientes eventos ocurrieron con este jugador y son hechos irrevocables. Refléjalos de forma coherente sin mencionarlos explícitamente salvo que el diálogo lo exija:

{{MEMORIAS}}

Cada bloque va encabezado por el nombre del personaje al que pertenece: son SUS recuerdos. No atribuyas a un personaje un hecho que no aparece en su bloque, ni des por sabido por él algo que solo consta en el bloque de otro — un secreto revelado a solas con el jugador no lo conoce el resto del reparto. El "tú" de las reglas de abajo es el personaje de cada bloque.

Reglas de coherencia:
— Si se te entregó un objeto, lo tienes encima ahora mismo.
— Si ocurrió algo físico (herida, cicatriz, cambio de estado), así estás en este momento.
— Si hiciste una promesa o juraste algo, lo recuerdas y actúas en consecuencia.
— Si sufriste una ofensa o trauma, tu tono y disposición lo reflejan — no lo olvides ni lo perdones a la ligera.
Estos hechos son parte de tu realidad presente, no del pasado. No rompas la coherencia de lo que ocurrió.`,
  sceneImagePrompt: `You are a visual scene director writing prompts for a Stable Diffusion / Flux image generator.
From the character sheets and the recent scene below, write ONE detailed image prompt in English that captures "THE MOMENT TO DEPICT".

STRICT RULES:
- Output ONLY the image prompt — no preamble, no explanation, no quotes, no labels.
- Comma-separated keywords and short phrases, cinematic photography style.
- 380–1150 words maximum.

IDENTITY vs. ACTION (keep these separate):
- A character's IDENTITY (face, body, hair, defining features) comes from their Appearance sheet and must stay consistent every time.
- Their POSE, GESTURE, EXPRESSION and GAZE come from what they are DOING and FEELING in the moment — never a default portrait.

MULTI-CHARACTER RULES (critical for correct generation):
- List EACH character separately with an explicit screen position: "on the left", "in the center", "on the right", "in the foreground", "in the background".
- Use the pattern: "[position], [name or role], [appearance & clothing], [specific pose & gesture], [expression & exactly where they are looking]" — repeat for every character present.
- Separate character descriptions with " | ".
- End with the setting, mood, lighting and composition keywords.

CHARACTERS:
{{characters}}

RECENT SCENE:
{{messages}}`,
  // Prompt de extracción del Índice de Contexto
  contextIndexPrompt: `Eres un cronista de historias de rol. Analiza el siguiente fragmento de conversación y extrae SOLO los elementos genuinamente importantes para recordar a largo plazo: eventos que cambian la trama, personajes con nombre y rol definidos, lugares relevantes para la historia, y conquistas o revelaciones clave (misiones completadas, objetos importantes obtenidos, secretos descubiertos).

PERSONAJES YA CONOCIDOS EN ESTA CONVERSACIÓN (no los re-extraigas salvo que haya información nueva relevante):
{{personajes_conocidos}}

HISTORIAS / MUNDOS VINCULADOS (sus lugares y eventos de lore ya están registrados):
{{historias_conocidas}}

FRAGMENTO (mensajes {{desde}}–{{hasta}} de {{total}} totales):
---
{{fragmento}}
---

Responde ÚNICAMENTE con etiquetas en este formato exacto, una por línea. Sin texto adicional antes ni después.

[EVENTO:título corto del evento|descripción en 1-2 frases de qué ocurrió y por qué importa|importancia del 1 al 10]
[PERSONAJE:nombre completo|quién es, su rol y cualquier dato clave nuevo que deba recordarse|importancia del 1 al 10]
[LUGAR:nombre del lugar|descripción y por qué es relevante para la historia|importancia del 1 al 10]
[CONQUISTA:nombre de la misión, objeto o revelación|qué se logró, obtuvo o descubrió y su relevancia para la historia|importancia del 1 al 10]

Reglas estrictas:
- Solo incluye elementos con importancia ≥ 6
- Máximo 6 entradas por tipo
- Si no hay elementos de un tipo, omite completamente esas etiquetas
- PERSONAJE: omite personajes ya conocidos salvo que el fragmento revele datos nuevos y relevantes
- CONQUISTA: solo para misiones completadas/activas, objetos con peso narrativo, o revelaciones que cambian la historia
- No inventes ni extrapoles — solo lo que está explícito en el fragmento`,
  contextIndexContextSize: 18192,
  // Auto-extracción del Índice de Contexto. Activado por defecto (2026-07-23):
  // ya no depende del LLM rápido — su cadena de resolución de provider cae a
  // `defaultProviderId` cuando no hay uno dedicado ni LLM rápido configurado
  // (ver autoExtractContextAsync). NOTA: esto solo afecta a instalaciones
  // NUEVAS — una fila ya existente en la tabla settings de una instalación en
  // marcha no se toca; hay que cambiarla a mano en Ajustes si se quiere activa.
  contextAutoExtractEnabled:    true,
  contextAutoExtractInterval:   8,
  contextAutoExtractProviderId: null,
  contextAutoExtractModelId:    null,
  // Llamadas auxiliares. Se conservan activadas para no cambiar instalaciones
  // existentes; pueden apagarse para preservar la KV cache del modelo principal.
  // Las dos de DECISIÓN (árbitro de tiradas y auto-update de tiempo/ubicación)
  // van OFF por defecto: usan el modelo principal y, al intercalarse con la
  // narración, desalojan su caché de prefijo en cada turno (conversación lenta).
  llmNsfwGuardEnabled:          true,
  diceRefereeEnabled:           false,
  worldStateAutoUpdateEnabled:  false,
  sceneDirectorEnabled:         true,
  autoSummariesEnabled:         true,
  // Generación de eventos de historia
  storyEventGenerationPrompt: `Eres un diseñador narrativo de juegos de rol. A partir del contexto de la historia que se te proporciona, genera exactamente {{NUM_EVENTOS}} eventos narrativos relevantes y concretos para esta historia.

CONTEXTO DE LA HISTORIA:
{{CONTEXTO_HISTORIA}}

INSTRUCCIONES:
- Cada evento debe encajar de forma natural en el mundo y tono de la historia
- El campo "disparador" describe QUÉ CONDICIÓN o ACCIÓN desencadena el evento (puede ser una decisión del jugador, llegar a un lugar, un umbral de tiempo, etc.)
- El campo "descripción" narra QUÉ OCURRE cuando el evento se activa (2-4 frases vívidas y concretas)
- El campo "ubicación" indica DÓNDE ocurre el evento (nombre del lugar) — permite al narrador guiar al jugador hacia allí. Reparte los eventos entre distintas ubicaciones
- La importancia (1-10) refleja el impacto narrativo: 8-10 para eventos cruciales de trama, 5-7 para subtramas, 1-4 para eventos de ambiente
- Varía los tipos: incluye conflictos, revelaciones, encuentros, cambios de estado del mundo, consecuencias de elecciones

Responde ÚNICAMENTE con etiquetas en este formato exacto, una por línea. Sin texto adicional antes ni después.

[EVENTO:título corto y evocador|disparador que activa el evento|descripción de lo que ocurre cuando se activa|importancia del 1 al 10|ubicación donde ocurre]`,
  // Generación de ubicaciones de historia
  storyLocationGenerationPrompt: `Eres un diseñador de mundos para juegos de rol. A partir del contexto de la historia que se te proporciona, genera exactamente {{NUM_UBICACIONES}} ubicaciones concretas y detalladas que existen en este mundo.

CONTEXTO DE LA HISTORIA:
{{CONTEXTO_HISTORIA}}

INSTRUCCIONES:
- Cada ubicación debe encajar de forma natural en el mundo y tono de la historia
- Nombre: identificador corto y evocador del lugar ("Sala del trono", "Callejón del mercado", "Cueva norte")
- Descripción: aspecto visual, dimensiones, atmósfera general (2-3 frases)
- Contenido: qué hay en el lugar — muebles, objetos, características fijas. Sé específico (1-2 frases)
- Salidas: qué conexiones existen hacia otros lugares. Sé concreto: "puerta sur → corredor este", "escalera → piso superior". Si es un callejón sin salida, dilo
- Atmósfera: luz, temperatura, olores, sonidos ambientales (1 frase)

REGLA CRÍTICA: Las salidas deben ser consistentes con otras ubicaciones. Si la "Sala del trono" tiene "puerta norte → antesala", entonces la "Antesala" debe tener "puerta sur → sala del trono".

Responde ÚNICAMENTE con etiquetas en este formato exacto, una por línea. Sin texto adicional antes ni después.

[UBICACION:nombre|descripción|contenido|salidas|atmósfera]`,

  // Asistente de historias — genera una ficha de historia completa + personajes a partir del briefing
  storyAssistantPrompt: `Eres un veterano diseñador de campañas y guionista de juegos de rol narrativo. A partir del briefing del usuario debes diseñar UNA historia completa y coherente, con sus personajes, eventos y ubicaciones, lista para jugarse.

BRIEFING DEL USUARIO:
- Temática / premisa: {{TEMATICA}}
- Género: {{GENERO}}
- Tono: {{TONO}}
- Ritmo deseado: {{RITMO}}
- Modo aventura/RPG: {{MODO_AVENTURA}}
- Mundo abierto: {{MUNDO_ABIERTO}}
- Nº de personajes a crear: {{NUM_PERSONAJES}}
- Nº de eventos a crear: {{NUM_EVENTOS}}
- Nº de ubicaciones a crear: {{NUM_UBICACIONES}}
- Personajes sugeridos por el usuario (respeta los nombres y notas dados; inventa el resto):
{{PERSONAJES_SUGERIDOS}}
- Notas adicionales: {{EXTRA}}

INSTRUCCIONES:
- Diseña una historia con identidad propia, conflicto central claro y ganchos de juego.
- El RITMO debe impregnar toda la historia: ajusta los eventos, las reglas narrativas y el contexto a ese ritmo.
- Crea EXACTAMENTE {{NUM_PERSONAJES}} personajes. Incluye los sugeridos por el usuario y complétalos; inventa el resto hasta llegar al número pedido.
- Cada personaje debe tener una personalidad distintiva y encajar en la trama; el "rol" indica su función en la historia (protagonista, antagonista, aliado, mentor, etc.).
- Las descripciones deben ser concretas y evocadoras, no genéricas.
- Escribe todo en español (salvo nombres propios que tengan sentido en otro idioma).

FORMATO DE SALIDA — responde ÚNICAMENTE con los bloques siguientes, sin texto antes ni después, respetando los marcadores y las etiquetas EXACTAMENTE:

===HISTORIA===
NOMBRE: <título de la historia>
DESCRIPCION: <resumen breve de 2-3 frases para la ficha>
CONTEXTO: <contexto global: la situación de partida, el conflicto central y lo que está en juego>
LORE: <mundo y trasfondo: lugares, facciones, historia, reglas del mundo>
REGLAS: <reglas narrativas para el narrador: tono, estilo, qué hacer y qué evitar>
===FIN HISTORIA===

(Repite este bloque {{NUM_PERSONAJES}} veces, uno por personaje:)
===PERSONAJE===
NOMBRE: <nombre del personaje>
ROL: <su función en la historia>
DESCRIPCION: <aspecto físico y rasgos visibles>
PERSONALIDAD: <carácter, motivaciones, forma de hablar>
LORE: <su trasfondo e historia personal>
TAGS: <3-5 etiquetas separadas por comas>
===FIN PERSONAJE===

(Después, {{NUM_EVENTOS}} eventos, una etiqueta por línea:)
[EVENTO:título corto|disparador que lo activa|qué ocurre cuando se activa|importancia del 1 al 10|ubicación donde ocurre (nombre de una de las ubicaciones generadas)]

(Después, {{NUM_UBICACIONES}} ubicaciones, una etiqueta por línea:)
[UBICACION:nombre|descripción|contenido|salidas|atmósfera]`,

  // Estilo de narración — inyectados justo antes del último mensaje cuando el usuario elige medium/short
  narrationMediumPrompt: `## Estilo de respuesta: MODERADO
Mantén respuestas de longitud moderada: 3-4 párrafos como máximo. Balancea diálogo y descripción sin extenderte. Evita introducciones largas y cierra cada escena con concisión.`,
  narrationShortPrompt: `## Estilo de respuesta: CONCISO
Responde de forma breve y directa: máximo 2 párrafos cortos. Ve al punto esencial. Prioriza el diálogo y la acción sobre la descripción ambiental. Nada de florituras.`,
  // Content moderation
  allowNsfw: false,
  nsfwBlockedMessage: `*[Moderación: el contenido de tu mensaje no está permitido con el modo NSFW desactivado. Si deseas este tipo de interacciones, activa "Permitir contenido adulto" en Ajustes → Generación.]*`,
  // Resúmenes de sucesos
  summaryMaxLength: 5,   // máximo de frases por resumen generado
  summaryBlockSize: 40,  // mensajes por bloque de resumen automático (inmutable)
  // API options
  disableFallbacks: false,
  // Thinking / razonamiento (esfuerzo recortado por familia de modelo en el proveedor)
  reasoningEnabled: false,
  reasoningEffort: 'high',
  // Cloudflare Access — para ComfyUI remoto tras túnel
  comfyUiCfClientId: null,
  comfyUiCfClientSecret: null,
  // Prompt de generación de descripción visual de personaje (para imagen)
  charImagePrompt: `Eres un experto en generar prompts para generadores de imágenes IA (Stable Diffusion, Midjourney, DALL-E).

Basándote en la siguiente descripción de un personaje, genera un prompt detallado en inglés para un generador de imágenes que capture su apariencia física de forma consistente.

El prompt debe incluir:
- Rasgos faciales específicos (forma de cara, ojos, nariz, boca, expresión habitual)
- Color y estilo de cabello
- Complexión física y altura aproximada
- Atuendo característico (ropa, colores, materiales, accesorios)
- Rasgos distintivos (cicatrices, tatuajes, marcas especiales)
- Estilo artístico sugerido (fantasy art, anime, realistic, dark fantasy, etc.)
- Iluminación y atmósfera que corresponda a su personalidad

Formato de salida: Un único párrafo en inglés de 100-150 palabras, listo para usar directamente en un generador de imágenes.

DATOS DEL PERSONAJE:
Nombre: {{nombre}}
Descripción: {{descripcion}}
Personalidad: {{personalidad}}
Lore: {{lore}}

Responde SOLO con el prompt de imagen, sin explicaciones adicionales.`,
  // Prompt de mejora de descripción para fondos de la ventana de chat
  backgroundImagePrompt: `Eres un experto generando prompts en inglés para IA de generación de imágenes (Stable Diffusion / ComfyUI), especializado en fondos y escenarios para juegos de rol.

Toma la siguiente descripción de un lugar o escenario (puede estar en español o ser muy breve) y conviértela en UN prompt detallado en inglés, listo para usar.

El prompt debe:
- Describir el entorno, arquitectura, vegetación, clima, hora del día e iluminación.
- Incluir palabras clave de estilo artístico y composición (fantasy art, digital painting, cinematic, wide shot, etc.).
- NO incluir personajes ni personas — es un fondo/escenario vacío.
- Ser un único párrafo de 60-120 palabras en inglés, sin comentarios, etiquetas ni comillas adicionales.

DESCRIPCIÓN: {{prompt}}`,
};

export class SettingsService {
  private get db() {
    return getDb();
  }

  /** Returns the compiled-in defaults (not DB values). */
  getDefaults(): AppSettings {
    return { ...DEFAULTS };
  }

  getAll(): AppSettings {
    const rows = this.db.select().from(settings).all();
    const map: Record<string, unknown> = {};
    for (const row of rows) {
      try {
        map[row.key] = resolveConversationPrompt(row.key, JSON.parse(row.value));
      } catch {
        map[row.key] = row.value;
      }
    }
    const result = { ...DEFAULTS, ...map } as AppSettings;
    // Migrate old Piper voice IDs (es_*) to the default Edge TTS voice
    const tts = result.ttsSettings as TtsSettings;
    if (tts?.defaultVoiceId && !tts.defaultVoiceId.startsWith('edge_')) {
      tts.defaultVoiceId = TTS_DEFAULTS.defaultVoiceId!;
    }
    return result;
  }

  get<K extends keyof AppSettings>(key: K): AppSettings[K] {
    const row = this.db.select().from(settings).where(eq(settings.key, key)).get();
    if (!row) return DEFAULTS[key];
    try {
      return resolveConversationPrompt(key, JSON.parse(row.value)) as AppSettings[K];
    } catch {
      return row.value as AppSettings[K];
    }
  }

  // Raw SQL upsert — avoids Drizzle ORM version quirks with onConflictDoUpdate
  set(key: string, value: unknown): void {
    const ts = new Date().toISOString();
    const serialized = JSON.stringify(value);
    this.db.run(
      sql`INSERT INTO settings (key, value, updated_at)
          VALUES (${key}, ${serialized}, ${ts})
          ON CONFLICT (key) DO UPDATE SET value = ${serialized}, updated_at = ${ts}`
    );
  }

  setMany(updates: Partial<AppSettings>): AppSettings {
    for (const [key, value] of Object.entries(updates)) {
      this.set(key, value);
    }
    return this.getAll();
  }

  reset(): AppSettings {
    this.setMany(DEFAULTS);
    return this.getAll();
  }
}
