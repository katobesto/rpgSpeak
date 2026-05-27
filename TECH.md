# Tech Stack — rpgSpeak

Documentación técnica de todas las tecnologías usadas en el proyecto.

---

## Backend

### Node.js (v20+)

**Qué es:** Entorno de ejecución JavaScript del lado del servidor, basado en el motor V8 de Chrome.

**Por qué aquí:** Permite usar el mismo lenguaje (TypeScript) en frontend y backend. Su modelo de I/O no bloqueante lo hace ideal para manejar múltiples conexiones SSE simultáneas durante el streaming de tokens. La versión 20 incluye `fetch` nativo y soporte estable de ESM.

**Dónde aparece:** Toda la carpeta `server/`.

---

### Fastify (v4)

**Qué es:** Framework web para Node.js de alto rendimiento. Es la alternativa moderna a Express.

**Por qué aquí:** Es 2–3× más rápido que Express en benchmarks reales gracias a su sistema de serialización JSON (fast-json-stringify) y su parseo de rutas optimizado. Tiene TypeScript nativo, sistema de plugins con control de scope, y schema validation integrada. El sistema de hooks permite interceptar cualquier fase del ciclo de vida de la request.

**Plugins usados:**
- `@fastify/cors` — Control de CORS para el cliente Vite en dev
- `@fastify/static` — Sirve el build de React en producción
- `@fastify/multipart` — Manejo de uploads (avatares, importación JSON)
- `@fastify/websocket` — Soporte WebSocket (preparado para futuros features)

**Dónde aparece:** `server/src/app.ts`, todos los archivos `*.routes.ts`

---

### TypeScript (v5)

**Qué es:** Superset tipado de JavaScript que compila a JS. Desarrollado por Microsoft.

**Por qué aquí:** En una aplicación con múltiples dominios (personajes, historias, conversaciones, proveedores) y una capa de abstracción LLM, los tipos son críticos para mantener la coherencia. TypeScript strict mode (`strict: true`) elimina clases enteras de bugs en tiempo de compilación. Los tipos compartidos entre server y client (`shared/types/`) aseguran que una misma interfaz `Character` sea usada en ambos lados.

**Configuración:** `server/tsconfig.json`, `client/tsconfig.json`

**Dónde aparece:** Todos los archivos `.ts` y `.tsx` del proyecto.

---

### Better-sqlite3

**Qué es:** Binding nativo de Node.js para SQLite3. A diferencia de `sqlite3` (basado en callbacks/promises), este es **síncrono**.

**Por qué aquí:** SQLite es el motor de base de datos perfecto para una aplicación local: zero-config, un único archivo `.db`, ACID-compliant, sin proceso de servidor separado. Better-sqlite3 siendo síncrono lo hace ideal con Fastify (que sí es async) porque las queries no bloquean el event loop de forma problemática pero son mucho más simples de escribir y depurar. Con WAL mode habilitado, el rendimiento de lecturas concurrentes es excelente.

**Configuraciones aplicadas:**
- `PRAGMA journal_mode = WAL` — Write-Ahead Logging para mejor concurrencia
- `PRAGMA foreign_keys = ON` — Integridad referencial en cascadas
- `PRAGMA synchronous = NORMAL` — Balance entre durabilidad y velocidad
- `PRAGMA cache_size = -32000` — 32MB de caché en memoria

**Dónde aparece:** `server/src/db/index.ts`

---

### Drizzle ORM (v0.30)

**Qué es:** ORM TypeScript-first, lightweight. A diferencia de Prisma o TypeORM, Drizzle genera SQL real sin capas de abstracción pesadas.

**Por qué aquí:** Ofrece tipos completamente inferidos desde el schema sin codegen adicional. El schema en `schema.ts` es el origen único de verdad: de ahí se infieren tanto los tipos de inserción como de selección. Es mucho más ligero que Prisma (que requiere un proceso "Query Engine" separado) y más type-safe que TypeORM. Las migraciones se hacen directamente con SQL crudo vía `sql` tagged template.

**Dónde aparece:** `server/src/db/schema.ts`, `server/src/db/index.ts`, todos los `*.repository.ts`

---

### Zod (v3)

**Qué es:** Librería de validación y parsing de schemas con TypeScript-first. Define esquemas de validación que también generan tipos TypeScript.

**Por qué aquí:** Valida todos los inputs que llegan al servidor desde el exterior (bodies de requests HTTP). Un `z.object({ name: z.string().min(1) }).safeParse(req.body)` tanto valida como tipifica el dato en un solo paso. Elimina la necesidad de validadores manuales y tipos manuales — son la misma cosa.

**Dónde aparece:** `server/src/modules/*/**.schema.ts`

---

### Pino (logging)

**Qué es:** Logger de Node.js de alto rendimiento. Viene incluido en Fastify.

**Por qué aquí:** Es el logger más rápido disponible para Node.js. En modo desarrollo usa `pino-pretty` para logs legibles y coloreados. En producción emite JSON estructurado, compatible con cualquier sistema de log aggregation (Loki, Datadog, etc.).

**Dónde aparece:** Configurado en `server/src/app.ts` a través de Fastify.

---

### uuid (v9)

**Qué es:** Generador de UUIDs v4 (aleatorios).

**Por qué aquí:** Cada entidad (personaje, historia, mensaje, conversación) necesita un ID único. UUID v4 garantiza unicidad sin necesidad de una secuencia centralizada, lo que es ideal para SQLite local.

**Dónde aparece:** Todos los repositorios (`*.repository.ts`), en las funciones `create()`.

---

### dotenv

**Qué es:** Carga variables de entorno desde un archivo `.env` al `process.env`.

**Por qué aquí:** Separa la configuración del código. Cada instalación puede tener su propio `.env` sin modificar el código fuente.

**Dónde aparece:** `server/src/config.ts`

---

## Frontend

### React (v18)

**Qué es:** Librería de Facebook para construir interfaces de usuario mediante componentes declarativos y un DOM virtual.

**Por qué aquí:** La interfaz de chat requiere actualizaciones de estado muy frecuentes (cada token de streaming es una actualización), y React es el ecosistema más maduro para manejar esto eficientemente. React 18 introduce `concurrent features`, `useDeferredValue` y mejoras en el batching automático que evitan re-renders innecesarios durante el streaming.

**Conceptos usados:** Hooks (`useState`, `useEffect`, `useRef`, `useMemo`, `useCallback`), Context vía Query Client, Suspense-ready con TanStack Query.

**Dónde aparece:** Toda la carpeta `client/src/`.

---

### Vite (v5)

**Qué es:** Build tool y dev server de nueva generación para JavaScript/TypeScript. Desarrollado por Evan You (creador de Vue).

**Por qué aquí:** Ofrece Hot Module Replacement (HMR) prácticamente instantáneo gracias a que sirve los módulos como ES modules nativos durante el desarrollo, sin bundling previo. En producción genera builds optimizados con Rollup. El proxy integrado (`/api → :3000`) elimina problemas de CORS en desarrollo. Arranca en < 500ms independientemente del tamaño del proyecto.

**Configuración:** `client/vite.config.ts`. Manual chunks configurados para dividir `react`, `query` y `ui` en chunks separados.

**Dónde aparece:** `client/vite.config.ts`, `client/package.json`

---

### Tailwind CSS (v3)

**Qué es:** Framework CSS utility-first. En lugar de escribir CSS en archivos separados, aplicas clases utilitarias directamente en el HTML/JSX.

**Por qué aquí:** Permite construir una UI personalizada sin el overhead de un sistema de componentes externo. Las clases como `flex`, `gap-3`, `rounded-xl`, `text-sm` son legibles y directas. JIT (Just-in-Time) compiler genera sólo el CSS realmente usado, resultando en builds muy pequeños. El sistema de design tokens via CSS variables (`var(--accent)`, `var(--surface-1)`) permite theming dinámico sin recompilar.

**Configuración:** `client/tailwind.config.js` extiende los colores con CSS variables para el sistema de temas.

**Dónde aparece:** `client/tailwind.config.js`, `client/src/index.css`, todos los componentes.

---

### Zustand (v4)

**Qué es:** Librería minimalista de gestión de estado global para React. Alternativa a Redux, Context API y MobX.

**Por qué aquí:** La gestión del estado del chat (conversación activa, mensajes, estado de streaming) necesita ser accesible desde múltiples componentes sin prop drilling. Zustand no requiere providers, reducers ni actions — simplemente defines un store con `create()` y accedes a él con un hook. Para el estado de streaming, donde cada token actualiza el mensaje activo, Zustand es mucho más eficiente que Context (que re-renderizaría todo el árbol).

**Stores:**
- `chat.store.ts` — Conversación activa, mensajes, streaming state, función `sendMessage`
- `ui.store.ts` — Panel activo, modales, sidebar collapsed, tema (con `persist` a localStorage)

**Dónde aparece:** `client/src/stores/`

---

### TanStack Query (React Query v5)

**Qué es:** Librería de gestión de estado del servidor para React. Maneja fetching, caching, sincronización y actualizaciones de datos remotos.

**Por qué aquí:** La aplicación hace muchas peticiones: listar personajes, cargar mensajes, listar proveedores, obtener modelos. Sin React Query, habría que gestionar manualmente los estados `loading/error/data`, el caching y la invalidación. Con React Query, `useQuery(['characters'], fetchCharacters)` automáticamente cachea el resultado, lo revalida cuando es necesario, y `useMutation` maneja optimistic updates e invalidación del cache tras mutaciones.

**Configuración:** `client/src/main.tsx` — `staleTime: 30s`, `retry: 1`, `refetchOnWindowFocus: false`.

**Dónde aparece:** Todos los componentes que hacen fetching (`useQuery`, `useMutation`).

---

### React Router (v6)

**Qué es:** Librería de routing declarativo para aplicaciones React. La librería estándar de facto para SPAs con React.

**Por qué aquí:** Gestiona la navegación entre las 4 páginas principales (Chat, Characters, Stories, Settings) sin recargar la página. Usa la History API del navegador.

**Rutas:**
- `/` → `ChatPage`
- `/characters` → `CharactersPage`
- `/stories` → `StoriesPage`
- `/settings` → `SettingsPage`

**Dónde aparece:** `client/src/App.tsx`, `client/src/main.tsx`, `client/src/components/layout/Sidebar.tsx`

---

### Marked (v12)

**Qué es:** Parser de Markdown a HTML, escrito en JavaScript. Rápido y sin dependencias.

**Por qué aquí:** Los mensajes del LLM frecuentemente incluyen Markdown: listas, código, negritas, blockquotes. Marked convierte ese Markdown a HTML que React puede renderizar.

**Dónde aparece:** `client/src/components/chat/MessageItem.tsx`

---

### DOMPurify (v3)

**Qué es:** Librería de sanitización de HTML para el navegador. Elimina scripts maliciosos y atributos peligrosos.

**Por qué aquí:** El HTML generado por Marked proviene de contenido generado por LLMs (no confiable por definición). DOMPurify sanitiza ese HTML antes de insertarlo en el DOM via `dangerouslySetInnerHTML`, previniendo ataques XSS. Solo permite tags seguros: `p`, `code`, `pre`, `ul`, `ol`, `li`, `blockquote`, `strong`, `em`, etc.

**Dónde aparece:** `client/src/components/chat/MessageItem.tsx`

---

### TanStack Virtual (v3)

**Qué es:** Librería de virtualización de listas. Renderiza sólo los elementos visibles en el viewport.

**Por qué aquí:** Las conversaciones pueden tener cientos o miles de mensajes. Sin virtualización, renderizar todos los mensajes a la vez causaría problemas de rendimiento graves (DOM muy grande, mucho trabajo para React). `useVirtualizer` calcula qué elementos son visibles y sólo los renderiza, haciendo scroll smooth incluso con miles de mensajes.

**Dónde aparece:** `client/src/components/chat/MessageList.tsx`

---

### Lucide React

**Qué es:** Librería de iconos SVG para React. Fork de Feather Icons, con 1000+ iconos.

**Por qué aquí:** Iconos consistentes y bien diseñados sin dependencias pesadas. Cada icono es un componente React que sólo incluye el SVG necesario (tree-shakeable). Tamaño configurable via prop `size`.

**Dónde aparece:** Todos los componentes de UI.

---

## Herramientas de Desarrollo

### ESLint

**Qué es:** Linter estático para JavaScript/TypeScript. Analiza el código sin ejecutarlo para detectar errores y malas prácticas.

**Por qué aquí:** Con TypeScript strict mode hay muchos potenciales errores que TypeScript no detecta (como variables sin usar, o patrones problemáticos). ESLint + `@typescript-eslint` añade reglas específicas de TypeScript.

**Configuración:** `.eslintrc.json`

---

### Prettier

**Qué es:** Formateador de código opinionated. Reformatea el código de forma consistente sin discusiones sobre estilo.

**Por qué aquí:** Elimina debates sobre comillas simples vs dobles, punto y coma, trailing commas. Todo el código tiene el mismo formato automáticamente.

**Configuración:** `.prettierrc` — single quotes, 100 chars width, trailing commas.

---

### tsx

**Qué es:** Ejecutor de TypeScript para Node.js, basado en esbuild. Alternativa a `ts-node` mucho más rápida.

**Por qué aquí:** Permite ejecutar archivos `.ts` directamente en Node.js sin un paso de compilación previo. En modo `tsx watch`, hace hot reload del servidor cuando cambia cualquier archivo TypeScript, similar a `nodemon` pero con soporte nativo de TypeScript.

**Dónde aparece:** `server/package.json` en el script `dev`.

---

### concurrently

**Qué es:** Ejecuta múltiples comandos npm en paralelo en la misma terminal.

**Por qué aquí:** El script `npm run dev` en el root necesita ejecutar simultáneamente `tsx watch` (servidor) y `vite` (cliente). Concurrently los corre en paralelo con prefijos de color para distinguir los logs.

**Dónde aparece:** `package.json` raíz.

---

## Arquitectura y Patrones

### Clean Architecture / Layered Architecture

El backend sigue una separación por capas:

```
Routes (HTTP layer)
  ↓
Services (Business Logic)
  ↓
Repositories (Data Access)
  ↓
Database (SQLite)
```

Cada capa sólo conoce la capa inmediatamente inferior. Las rutas no tocan la base de datos directamente.

---

### Repository Pattern

Los repositorios encapsulan todo el acceso a datos. El service no sabe si el dato viene de SQLite, de un cache, o de una API externa. Esto facilita el testing y el cambio de backend de persistencia.

---

### Factory Pattern (LLM Providers)

`provider.factory.ts` crea instancias de providers a partir de configuración. Cachea instancias por `id + updatedAt` para evitar crear objetos innecesariamente. Añadir un nuevo provider es implementar `LLMProvider` y añadir un case al switch.

---

### Server-Sent Events (SSE)

El streaming de tokens usa SSE en lugar de WebSockets porque:
- Es unidireccional (servidor → cliente), que es exactamente lo que necesitamos
- Es más simple que WebSocket (no necesita handshake)
- Funciona sobre HTTP/1.1 y HTTP/2
- Los navegadores lo reconectan automáticamente si se cae
- Compatible con todos los proxies HTTP sin configuración especial

Formato de evento:
```
data: {"type":"token","token":"Hello"}

data: {"type":"done","messageId":"uuid","tokens":42}
```

---

### Optimistic UI

El `chat.store.ts` implementa optimistic updates: cuando el usuario envía un mensaje, se añade inmediatamente al estado local sin esperar la respuesta del servidor. El mensaje de respuesta del asistente también aparece instantáneamente como placeholder con typing indicator antes de que llegue el primer token.

---

### Context Window Management

El `context-builder.ts` ensambla el contexto en un orden específico y prioritario. El `context-trimmer.ts` usa una heurística de ~4 chars/token para estimar el uso de tokens y elimina mensajes antiguos del medio de la conversación, preservando siempre el sistema de mensajes y los mensajes más recientes.

---

## Base de Datos

### Diseño del Schema

```
characters ──────────────────────────────────────────────┐
stories ─────────────────────────────────────────────────┤
                                                          │
story_characters (M:N) ←── stories + characters          │
                                                          │
conversations ──────────────────────────────────────────┐│
                                                         ││
conversation_characters (M:N) ←── conversations + chars ││
conversation_stories (M:N) ←── conversations + stories  ││
                                                         ││
messages ←── conversations                               ││
  └── parentId (self-ref, para branching)                ││
                                                         ││
memory_entries ←── conversations (+ optional character) ││
                                                         ││
providers                                                ││
settings (key-value)                                     ││
```

### Serialización de JSON en SQLite

SQLite no tiene tipo nativo array/object. Los campos complejos (tags, exampleDialogue, llmParams, etc.) se serializan como `TEXT` con `JSON.stringify()` y se deserializan con `JSON.parse()` en el repositorio. Drizzle no hace esto automáticamente, pero los repositorios lo encapsulan completamente.
