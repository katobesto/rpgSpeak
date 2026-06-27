# rpgSpeak — Resumen del proyecto

## ¿Qué es?

**rpgSpeak** es una plataforma local-first de *roleplay* con personajes de IA, inspirada en Character.AI y SillyTavern pero pensada para "power users" que quieren control total sobre el modelo, los datos y el comportamiento del sistema. El objetivo central es permitir que un usuario **se sumerja en sus propias historias** (worldbuilding propio, personajes propios) y mantenga **conversaciones profundas y persistentes** con esos personajes, en lugar de chats genéricos sin memoria ni continuidad.

No es un wrapper trivial sobre un LLM: es un **motor narrativo** que añade estado persistente (memoria, afinidad, ubicación), control de tono (modo narrador vs. personaje), salvaguardas de contenido configurables, y generación de imágenes contextual (retratos, escenas) integrada en el propio flujo de chat.

## Stack técnico

- **Monorepo npm workspaces**: `server/` (Fastify + TypeScript), `client/` (React 18 + Vite + Zustand + TanStack Query), `shared/` (tipos TS compartidos), `tts-service/` (Python FastAPI con Edge TTS).
- **Base de datos**: SQLite vía `better-sqlite3` + Drizzle ORM. Diseño 100% local: no depende de servicios cloud propios, solo de los proveedores LLM/imagen que el usuario configure.
- **Multi-proveedor LLM**: patrón factory (`server/src/core/llm/`) con implementaciones para Ollama, OpenAI-compatible, LM Studio, KoboldCpp, Oobabooga, OpenRouter y "custom". Cada proveedor implementa `generate()`, `stream()`, `listModels()`, `validate()` — el usuario puede usar modelos 100% locales o APIs externas, indistintamente.
- **Streaming**: generación de texto vía SSE (Server-Sent Events) token a token, con reconciliación de IDs optimistas (mensajes "temp-" del cliente) contra los IDs reales persistidos en servidor.
- **Roles**: `admin` (control total: proveedores, modelos, generación de imágenes, usuarios) vs `user` (solo perfil y apariencia) — pensado para que un admin despliegue la instancia y comparta acceso controlado con otros usuarios (familiares, amigos, jugadores de su mesa).

## Conceptos narrativos desarrollados

### 1. Pipeline de generación contextual
El motor (`engine.ts`) no envía solo "el último mensaje" al LLM: construye un contexto completo (`buildContext()`) combinando:
- System prompt del personaje (personalidad, estilo, reglas).
- Lore de "stories" (documentos de worldbuilding vinculados a la conversación).
- Entradas de memoria relevantes para esa conversación/personaje.
- Historial de mensajes, recortado (`trimContext()`) para caber en el presupuesto de tokens configurado (`MAX_CONTEXT_TOKENS`).

### 2. Sistema de memoria
Cada conversación puede acumular "memorias" (eventos importantes, ofensas, traumas, hitos) con un campo de `importance`. El motor filtra estas memorias por tipo y relevancia (p. ej. solo memorias de tipo `offense`/`trauma` con `importance >= 5`) para inyectarlas selectivamente en el contexto — los personajes "recuerdan" lo que importa sin saturar la ventana de contexto con ruido.

### 3. Sistema de afinidad (relación personaje↔jugador)
Cada personaje tiene un valor de **afinidad** (0-100) hacia el jugador, que evoluciona según la conversación (`affinityUpdates`). Por debajo de 80, el motor inyecta directivas de comportamiento explícitas según el tramo:
- `<20`: hostilidad activa
- `20-40`: frialdad y desconfianza
- `40-60`: neutralidad
- `60-80`: cercanía moderada

Esto hace que la relación con cada personaje tenga consecuencias narrativas tangibles y persistentes, no solo cosméticas.

### 4. Modo Narrador vs. modo Personaje
El usuario puede hablar con un personaje específico (este responde en primera persona, manteniendo su voz) o activar el **modo Narrador**, donde el sistema resuelve el proveedor/modelo desde los ajustes globales o el primer personaje del grupo, y genera prosa narrativa de tercera persona que puede involucrar a varios personajes del grupo a la vez ("Continúa la historia").

### 5. Seguimiento de ubicación ("LOCATION")
El motor extrae y mantiene un bloque de "ubicación actual" de la historia (`locationUpdate`), inyectado tanto en modo personaje como en modo narrador, para que la escena tenga continuidad espacial coherente entre turnos.

### 6. "Intentos de salvaguardas" — NSFW Content Guard
Es importante remarcar que las salvaguardas son **configurables por el operador**, no impuestas de forma rígida — refleja la filosofía "power user, control total":
- Si `settings.allowNsfw === false`, se activa un guard de dos capas:
  1. **Capa regex**: bloqueo rápido por patrones explícitos.
  2. **Capa LLM clasificador**: un segundo LLM (rápido) recibe el mensaje del usuario y responde solo `SAFE` o `NSFW`; si el clasificador no responde a tiempo, se asume `SAFE` por defecto (fail-open, priorizando UX sobre bloqueo agresivo).
- Si se detecta contenido NSFW, se persiste un mensaje "bloqueado" (`metadata: { blocked: true, reason: 'nsfw' }`) con un texto configurable (`nsfwBlockedMessage`) en lugar de generar la respuesta.
- Si `allowNsfw === true`, este guard se omite por completo — el sistema está diseñado para adultos que controlan su propia instancia y deciden el nivel de contenido.

Esto se describe como "intentos de salvaguardas" porque es un sistema de mitigación de mejor esfuerzo (regex + clasificador LLM), no una garantía formal — adecuado para un despliegue personal/privado, no para un servicio público sin supervisión.

### 7. Ramificación de mensajes (branching)
Las conversaciones soportan branches (`branchId`), permitiendo explorar caminos narrativos alternativos desde un punto dado sin perder el historial original — útil para "qué pasaría si..." dentro de la misma historia.

### 8. Voz (TTS)
Servicio Python independiente (`tts-service/`) basado en **Microsoft Edge TTS** (neural, cloud, sin API key), proxied por el servidor Node — permite que los personajes "hablen" sus respuestas.

## Generación de imágenes — integración con bzComfy

rpgSpeak permite generar **imágenes contextuales desde el chat**: retratos de personajes y "escenas" (snapshots visuales de un momento de la historia), usando el contenido de la conversación como prompt.

Soporta varios backends de imagen (`imageProvider`): `comfyui` (directo), `bzcomfy`, `pollinations`, `gemini`, `fal` — vía un patrón `ImageProvider` similar al de LLM.

**bzComfy** es un proyecto hermano dentro del mismo repo (`bzComfy/`): un servidor Express + frontend propio que actúa como **interfaz/orquestador para ComfyUI** (un motor de generación de imágenes basado en Stable Diffusion / nodos). bzComfy expone:
- Una API REST (`/api/generate`, `/api/progress/:promptId` vía SSE, `/api/image`, `/api/upload`, `/api/workflows`, `/api/loras`, `/api/resolution-options`) que rpgSpeak consume como backend de imagen (`BzComfyImageProvider`).
- Un frontend propio (puerto 2500) independiente, pensado como herramienta standalone para gestionar/probar workflows de ComfyUI (selección de modelo base, LoRAs, resoluciones, FaceID, etc.) — sin relación directa con la UI de rpgSpeak, pero comparte los **mismos archivos de workflow** (`data/comfy-workflows/*_api.json` + `*_meta.json`) que ambos sistemas leen.

Esto significa que rpgSpeak y bzComfy son proyectos desacoplados pero **co-dependientes en los datos de configuración de workflows**: cambios en los metadatos de un workflow (modelos permitidos, soporte de LoRA, control de resolución) pueden afectar lo que la UI de rpgSpeak muestra como "controles disponibles" para generar una imagen, aunque el código de ambos frontends sea independiente.

## En conjunto: qué representa el proyecto

rpgSpeak es un experimento de **infraestructura personal de narrativa con IA**: el usuario es dueño de sus personajes, su mundo, sus modelos y sus datos. Los conceptos clave que se han ido desarrollando (memoria, afinidad, ubicación, modos narrador/personaje, branching, generación de imágenes contextual, salvaguardas configurables) apuntan todos a la misma meta — que las conversaciones con personajes de IA tengan **continuidad, consecuencias y profundidad** a lo largo del tiempo, en lugar de ser interacciones aisladas sin memoria. bzComfy complementa esto añadiendo la capa visual: que la historia también se pueda "ver", generando arte coherente con lo que está pasando en la narrativa.
