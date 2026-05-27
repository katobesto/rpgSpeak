# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Install and set up for the current platform (run this when switching Mac ↔ Windows)
./install.sh          # Mac/Linux
.\install.ps1         # Windows — also runs: npm rebuild better-sqlite3

# Start all services in development (server + Vite client + Python TTS)
./dev.sh              # Mac/Linux  — LAN accessible by default
.\dev.ps1             # Windows    — LAN accessible by default
.\dev.ps1 --local     # Windows    — localhost only (server HOST=127.0.0.1, Vite no --host)

# Build everything (shared → server → client, in that order)
npm run build

# Run the production server (after building)
npm run start -w server

# Lint
npm run lint          # both workspaces
npm run lint -w server
npm run lint -w client

# Format
npm run format

# Database migrations (run after schema changes)
npm run db:migrate -w server

# Rebuild native module after platform switch
npm rebuild better-sqlite3
```

No test suite exists in the project.

## Architecture

### Monorepo layout

```
server/   Fastify + TypeScript API (port 3000)
client/   React 18 + Vite SPA (port 5173 in dev)
shared/   TypeScript types consumed by both
tts-service/  Python FastAPI wrapping Piper TTS (port 8020)
data/     SQLite DB + uploaded images + TTS voice models
```

npm workspaces link `@rpgspeak/shared` into both `server` and `client` without publishing.
The server serves `client/dist` as static files in production (`@fastify/static`).

### Server

**Entry**: `server/src/index.ts` → `buildApp()` in `server/src/app.ts`

All API routes live under `/api`. The route registration in `app.ts` is the single place that controls which routes are public vs. JWT-protected. `requireAuth` and `requireAdmin` are Fastify `preHandler` hooks in `server/src/middleware/auth.ts`.

**Module layout** (each module = routes + service + repository):
```
server/src/modules/
  auth/          POST /api/auth/login, /register
  users/         CRUD — admin-only endpoints gated by requireAdmin
  characters/    CRUD + avatar upload
  conversations/ CRUD + character/story linking
  messages/      CRUD + branch support
  stories/       CRUD (world-building context documents)
  providers/     LLM provider CRUD + model listing
  generate/      SSE streaming endpoint — the core generation pipeline
  settings/      Key-value app settings
  tts/           Proxy/control for the Python TTS service
  memories/      Per-conversation memory entries
```

**Generation pipeline** (`server/src/core/conversation/engine.ts`):
1. Resolves character + provider/model (character override → settings default)
2. Calls `buildContext()` to assemble the prompt from system prompts, lore, memory entries, conversation history
3. Calls `trimContext()` to fit within the configured token budget
4. Streams tokens from the LLM provider implementation
5. Persists the completed message and updates affinity scores

**LLM providers** (`server/src/core/llm/`): factory pattern. Each provider (`ollama`, `openai`, `lmstudio`, `kobold`, `oobabooga`, `openrouter`, `custom`) implements `LLMProvider` with `generate()`, `stream()`, `listModels()`, and `validate()`.

**Database**: `better-sqlite3` + Drizzle ORM. Schema in `server/src/db/schema.ts`. Settings are stored as key-value rows in the `settings` table (not individual columns). The `initDb()` call is in `server/src/index.ts`; everywhere else uses `getDb()`.

**Platform-critical**: `better-sqlite3` compiles a native `.node` binary. When switching between Mac and Windows, run `npm rebuild better-sqlite3`. Both dev launchers (`dev.sh` / `dev.ps1`) detect the wrong-platform binary on startup (Mac binary = Mach-O, Windows binary = PE/MZ header) and auto-run the rebuild.

### Client

**Routing**: `react-router-dom` v6 in `client/src/App.tsx`. Three top-level pages: `ChatPage`, `CharactersPage`, `SettingsPage`.

**State management**: Zustand stores (no Redux).
- `useAuthStore` — JWT token + current user, persisted in `localStorage`. `isAdmin: boolean` derived from `user.role === 'admin'`.
- `useChatStore` — active conversation, message list, streaming state. `sendMessage()` is entirely in this store; it calls `streamGenerate()` which drives the SSE connection and handles optimistic updates.
- `useUiStore` — theme, sidebar open/close.

**Server state**: TanStack Query (`@tanstack/react-query`) for all API fetches. Query keys follow the pattern `['resource']` or `['resource', id]`.

**Styling**: Tailwind CSS utility classes throughout. Theme (dark/light) + accent color are CSS variables set at the root by `useUiStore`. Design tokens: `--surface-1`, `--surface-2`, `--border`, `--text-primary`, `--text-secondary`, `--text-muted`, `--accent`, `--accent-muted`, `--accent-hover`.

**Key components**:
- `client/src/components/chat/ChatWindow.tsx` — the main chat view; renders `MessageList`, `MessageInput`, `GroupPanel`, modals.
- `client/src/components/settings/SettingsPanel.tsx` — all settings UI in one large file (~2100 lines). Tab visibility is role-gated: `admin` sees all 8 tabs; `user` sees only **Perfil** and **Apariencia**.
- `client/src/components/characters/CharacterEditor.tsx` — full character creation/edit form.

### Role system

Two roles: `admin` and `user`. Enforced on:
- **Server**: `requireAdmin` preHandler on admin-only routes.
- **Client**: `isAdmin` from `useAuthStore` gates tab visibility in `SettingsPanel` and any admin-only UI (user management, provider config, generation config, etc.). Model/provider selection is only available to admins via Settings → Generación.

### TTS service

Independent Python process (`tts-service/tts_server.py`). The Node server proxies TTS requests to it at `http://localhost:8020`. The venv is created automatically by `dev.sh`/`dev.ps1` on first run at `tts-service/venv/`. Mac uses `venv/bin/python`; Windows uses `venv/Scripts/python.exe`. If the venv belongs to another platform, the install scripts detect and recreate it.

### Environment

`.env` (copied from `.env.example` by install scripts). Key variables:
```
PORT=3000
HOST=localhost
DB_PATH=data/rpgspeak.db   # relative to project root
LOG_LEVEL=info
CORS_ORIGIN=http://localhost:5173
MAX_CONTEXT_TOKENS=8192
```

### Adding a new API module

1. Create `server/src/modules/<name>/` with `<name>.routes.ts`, `<name>.service.ts`, `<name>.repository.ts`
2. Register in `server/src/app.ts` under the protected plugin block
3. Add the corresponding API client functions in `client/src/api/<name>.ts`
4. Add shared DTOs/types to `shared/types/index.ts` if needed (rebuild shared: `npm run build -w shared`)
