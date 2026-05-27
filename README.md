# rpgSpeak

> Local AI character roleplay platform. Inspired by Character.AI and SillyTavern, built for power users who want full control.

---

## Quick Start

```bash
# 1. Install
./install.sh        # or: npm install && cp .env.example .env

# 2. Run in development
npm run dev         # Server: :3000  ·  Client: :5173

# 3. Open
open http://localhost:5173
```

### With Docker

```bash
docker-compose up -d
open http://localhost:3000
```

---

## Features

| Feature | Status |
|---|---|
| Character creation & management | ✅ |
| Story / scenario system | ✅ |
| Persistent conversations | ✅ |
| Multi-character conversations | ✅ |
| Token streaming (SSE) | ✅ |
| Message branching | ✅ |
| Memory system | ✅ |
| Context trimming | ✅ |
| Markdown rendering | ✅ |
| Dark / light theme | ✅ |
| Provider management UI | ✅ |
| Import / export characters | ✅ |
| Ollama support | ✅ |
| OpenAI-compatible APIs | ✅ |
| LM Studio | ✅ |
| OpenRouter | ✅ |
| KoboldCpp | ✅ |
| Oobabooga | ✅ |

---

## Project Structure

```
rpgSpeak/
├── server/                  # Fastify backend (Node.js + TypeScript)
│   └── src/
│       ├── app.ts           # Fastify app factory
│       ├── config.ts        # Environment configuration
│       ├── db/
│       │   ├── schema.ts    # Drizzle ORM table definitions
│       │   ├── index.ts     # DB connection (better-sqlite3)
│       │   └── migrations.ts# DDL migrations + seed data
│       ├── modules/         # Feature modules (routes/service/repository)
│       │   ├── characters/
│       │   ├── stories/
│       │   ├── conversations/
│       │   ├── messages/
│       │   ├── providers/
│       │   ├── settings/
│       │   └── generate/    # SSE streaming endpoint
│       └── core/
│           ├── llm/         # Provider abstraction + implementations
│           └── conversation/ # Engine, context builder, trimmer
├── client/                  # React 18 SPA (Vite + TypeScript)
│   └── src/
│       ├── api/             # Typed API client functions
│       ├── stores/          # Zustand state stores
│       ├── components/      # UI components
│       │   ├── chat/        # ChatWindow, MessageList, MessageInput
│       │   ├── characters/  # CharacterCard, CharacterEditor
│       │   ├── stories/     # StoryEditor
│       │   ├── settings/    # SettingsPanel, ProviderConfig
│       │   ├── layout/      # MainLayout, Sidebar
│       │   └── ui/          # Button, Input, Modal, Avatar
│       └── pages/           # Route-level components
├── shared/
│   └── types/index.ts       # Shared TypeScript types (server + client)
├── docker-compose.yml
├── Dockerfile
└── install.sh
```

---

## LLM Providers

rpgSpeak supports any LLM that runs locally or via API:

| Provider | Type | Notes |
|---|---|---|
| Ollama | `ollama` | Native API. Auto-detecta modelos |
| LM Studio | `lmstudio` | API OpenAI-compatible. Activar "Local Server" en la app |
| MLX (Apple Silicon) | `mlx` | `mlx_lm.server` — sólo macOS con chip Apple |
| OpenAI | `openai` | Requiere API key |
| OpenRouter | `openrouter` | Cloud-routed, requiere API key |
| KoboldCpp | `kobold` | API nativa de KoboldCpp |
| Oobabooga | `oobabooga` | OpenAI-compatible con flag `--api` |
| Custom | `custom` | Cualquier endpoint OpenAI-compatible |

### Adding a Provider

Go to **Settings → Providers → Add Provider**, fill in the URL and optional API key, and click **Test Connection** to verify.

---

## Character System

Characters are the core building block. Each character has:

- **System Prompt** — The main instruction defining behavior
- **Personality** — Traits, speech patterns, mannerisms
- **Lore** — Background, world context
- **Example Dialogues** — Few-shot examples injected into context
- **LLM Parameters** — Per-character temperature, model, context length
- **Memory** — Rolling window, summarized, or disabled

### Context Assembly Order

```
[Global System Prompt]
[Character Definition: name + system prompt + personality + lore]
[Story Context (if active)]
[Memory Entries]
[Example Dialogues (few-shot)]
[Conversation History (trimmed to fit)]
```

---

## Story System

Stories add persistent context to conversations:

- **Global Context** — Scenario description
- **World Lore** — Setting details
- **Narrative Rules** — How the AI should behave
- **Persistent Events** — Key events the AI knows about
- **State Variables** — Key-value pairs (e.g. `weather: stormy`)
- **Behavior Restrictions** — Hard rules

Multiple stories can be active simultaneously and are layered in priority order.

---

## API Reference

All endpoints under `/api/`. Responses follow `{ success: true, data: T }`.

| Method | Path | Description |
|---|---|---|
| GET | `/characters` | List characters |
| POST | `/characters` | Create character |
| PATCH | `/characters/:id` | Update character |
| POST | `/characters/:id/duplicate` | Duplicate |
| GET | `/stories` | List stories |
| POST | `/stories` | Create story |
| GET | `/conversations` | List conversations |
| POST | `/conversations` | Create conversation |
| GET | `/messages?conversationId=` | List messages |
| **POST** | **`/generate/stream`** | **SSE streaming generation** |
| POST | `/generate/sync` | Non-streaming generation |
| GET | `/providers` | List providers |
| GET | `/providers/:id/models` | List provider models |
| GET | `/providers/:id/validate` | Test connection |
| GET | `/settings` | Get all settings |
| PATCH | `/settings` | Update settings |

### Streaming Generation

```js
// POST /api/generate/stream
{
  "conversationId": "uuid",
  "message": "Hello!",
  "characterId": "uuid",  // optional, uses active character
  "overrides": {          // optional
    "temperature": 0.9,
    "model": "llama3"
  }
}

// SSE Response events:
// data: {"type": "token", "token": "Hello"}
// data: {"type": "done", "messageId": "uuid", "tokens": 123}
// data: {"type": "error", "error": "message"}
```

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Server port |
| `HOST` | `localhost` | Bind address |
| `NODE_ENV` | `development` | Environment |
| `DB_PATH` | `./data/rpgspeak.db` | SQLite database path |
| `LOG_LEVEL` | `info` | Pino log level |
| `CORS_ORIGIN` | `http://localhost:5173` | Allowed CORS origin |
| `MAX_CONTEXT_TOKENS` | `8192` | Global token limit |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Default Ollama URL |

---

## Development

```bash
npm run dev      # Both server + client with hot reload
npm run build    # Production build
npm run lint     # ESLint
npm run format   # Prettier
```

The dev server proxies `/api/*` from `:5173` → `:3000` automatically.

---

## Tech Stack

See [TECH.md](TECH.md) for a detailed description of every technology used.
