import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import { sql } from 'drizzle-orm';
import type { Character, Message, ChatMessage, Story, NarrativeThread } from '@rpgspeak/shared';
import { initDb } from '../src/db/index.js';
import { buildContext, buildVarietyBlock } from '../src/core/conversation/context-builder.js';
import { trimContext, trimContextWithSummary, estimateContextTokens } from '../src/core/conversation/context-trimmer.js';
import { CONVERSATION_PROMPTS, resolveConversationPrompt } from '../src/modules/settings/conversation-prompts.js';
import { ProviderRepository } from '../src/modules/providers/provider.repository.js';

// Base aislada en memoria: ninguna prueba abre los datos de una partida real.
const db = initDb(':memory:');
db.run(sql`CREATE TABLE memory_entries (id TEXT, conversation_id TEXT, character_id TEXT, type TEXT, content TEXT, importance INTEGER, is_active INTEGER, created_at TEXT, updated_at TEXT)`);
db.run(sql`CREATE TABLE providers (id TEXT PRIMARY KEY, name TEXT, type TEXT, base_url TEXT, api_key TEXT, default_model TEXT, is_enabled INTEGER, config TEXT, created_at TEXT, updated_at TEXT)`);

const character: Character = {
  id: 'aria', name: 'Aria', userId: null, ownerName: null, storyIds: [], avatar: null,
  description: 'Exploradora humana', personality: 'Reservada', systemPrompt: '', lore: '',
  exampleDialogue: [{ user: 'Hola', assistant: 'Te escucho.' }], tags: [], temperature: 0.8,
  modelId: null, providerId: null, contextLength: 32768, memoryEnabled: true,
  memoryType: 'rolling', memoryWindow: 40, llmParams: {}, relations: [], rpgStats: {},
  imageDescription: null, gallery: [], createdAt: '', updatedAt: '',
};

function message(i: number, content = `Turno ${i}`, characterId: string | null = i % 2 ? 'aria' : null): Message {
  return {
    id: String(i), conversationId: 'test', parentId: null, branchId: 'main',
    role: i % 2 ? 'assistant' : 'user', content, characterId,
    tokens: 0, isActive: true, metadata: {}, createdAt: '', updatedAt: '',
  };
}

const options = {
  character, stories: [], conversationId: 'test', ...CONVERSATION_PROMPTS,
  userDisplayName: 'Jugador', maxMessages: 60,
};

test('affinity, location and notes cannot change the stable system or voice examples', async () => {
  const messages = [message(0), message(1), message(2)];
  const first = await buildContext({ ...options, messages,
    characterAffinities: [{ characterId: 'aria', name: 'Aria', affinity: 50 }], currentLocation: 'Taberna' });
  const second = await buildContext({ ...options, messages,
    characterAffinities: [{ characterId: 'aria', name: 'Aria', affinity: 85 }], currentLocation: 'Bosque' });
  assert.equal(first.prefixCount, 3);
  assert.deepEqual(first.messages.slice(0, first.prefixCount + 2), second.messages.slice(0, second.prefixCount + 2));
  assert.doesNotMatch(first.messages[0].content, /afinidad 50\/100|Taberna/);
  assert.match(second.messages.slice(-second.footerCount).map((m) => m.content).join('\n'), /afinidad 85\/100|Bosque/);
});

test('small windows always retain the current user message', async () => {
  for (const maxMessages of [1, 2, 3, 4, 7, 8, 60]) {
    const messages = Array.from({ length: 101 }, (_, i) => message(i));
    const result = await buildContext({ ...options, messages, maxMessages });
    assert.equal(result.messages.at(-1)?.content, 'Turno 100');
    assert.equal(result.messages.at(-1)?.role, 'user');
    assert.equal(result.messages.slice(result.prefixCount).find((m) => m.role !== 'system')?.role, 'user');
  }
});

test('character context excludes private scenes with another character', async () => {
  const other = { ...character, id: 'bren', name: 'Bren' };
  const messages = [message(0, 'Te cuento un secreto'), message(1, 'El secreto privado', 'bren'), message(2, 'Hola Aria')];
  const result = await buildContext({ ...options, messages, groupCharacters: [other],
    summary: 'Resumen global privado', characterSummary: 'Solo recuerdos propios' });
  const text = result.messages.map((m) => m.content).join('\n');
  assert.doesNotMatch(text, /El secreto privado|Te cuento un secreto|Resumen global privado/);
  assert.match(text, /Solo recuerdos propios/);
  assert.equal(result.messages.at(-1)?.content, 'Hola Aria');
});

test('variety reminder only appears for repeated phrases or openings of the active voice', () => {
  const distinct = [message(1, 'La puerta cruje al fondo del corredor.'), message(3, 'Mira ese mapa antes de salir.')];
  assert.equal(buildVarietyBlock(distinct, false, 'aria'), null);
  const repeated = [message(1, 'Te mira a los ojos y espera.'), message(3, 'Te mira a los ojos y sonríe.')];
  assert.match(buildVarietyBlock(repeated, false, 'aria')!, /Te mira a los ojos/);
  assert.equal(buildVarietyBlock(repeated.map((m) => ({ ...m, characterId: 'otro' })), false, 'aria'), null);
  const narrated = [message(1, '| Noche | 22:30 | Taberna |\n\nUna rama rompe el silencio del bosque.', null),
    message(3, '| Noche | 22:30 | Taberna |\n\nBren busca la llave entre sus cosas.', null)];
  assert.equal(buildVarietyBlock(narrated, true, null), null);
});

test('token trimming protects examples, footer and current message, respecting budget', () => {
  const header: ChatMessage[] = [{ role: 'system', content: 'Reglas' }, { role: 'user', content: 'Ejemplo' }, { role: 'assistant', content: 'Voz' }];
  const history: ChatMessage[] = Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `${i} ${'x'.repeat(120)}` }));
  const footer: ChatMessage[] = [{ role: 'system', content: 'Datos del turno' }, { role: 'user', content: 'Actual' }];
  const result = trimContext([...header, ...history, ...footer], 450, 8, { prefixCount: 3, requiredRecent: 2 });
  assert.deepEqual(result.messages.slice(0, 3), header);
  assert.deepEqual(result.messages.slice(-2), footer);
  assert.equal(result.messages[3].role, 'user');
  assert.ok(estimateContextTokens(result.messages) <= 450);
});

test('token trimming can relax recent history but never discard a mandatory footer', () => {
  const messages: ChatMessage[] = [{ role: 'system', content: 'reglas' },
    ...Array.from({ length: 6 }, (_, i): ChatMessage => ({ role: i % 2 ? 'assistant' : 'user', content: 'x'.repeat(400) })),
    { role: 'system', content: 'canon' }, { role: 'user', content: 'actual' }];
  const result = trimContext(messages, 50, 8, { requiredRecent: 2, prefixCount: 1 });
  assert.ok(result.estimatedTokens <= 50);
  assert.deepEqual(result.messages.slice(-2), messages.slice(-2));
  assert.throws(() => trimContext(messages, 10, 8, { requiredRecent: 2, prefixCount: 1 }), /superan el presupuesto/);
});

test('ordinary new turns do not slide the history cut on every request', () => {
  const make = (length: number): ChatMessage[] => [{ role: 'system', content: 'reglas' },
    ...Array.from({ length }, (_, i): ChatMessage => ({ role: i % 2 ? 'assistant' : 'user', content: `${i} ${'x'.repeat(40)}` })),
    { role: 'system', content: 'estado' }, { role: 'user', content: 'actual' }];
  const first = trimContext(make(42), 400, 8, { requiredRecent: 2 });
  const next = trimContext(make(44), 400, 8, { requiredRecent: 2 });
  assert.equal(first.messages[1].content, next.messages[1].content);
});

test('customized prompts, including empty values, remain unchanged', () => {
  for (const [key, defaultValue] of Object.entries(CONVERSATION_PROMPTS)) {
    for (const value of ['', 'Mi prompt personalizado', defaultValue, `${defaultValue}\nPersonalización`]) {
      assert.equal(resolveConversationPrompt(key, value), value);
    }
  }
});

test('token-based trimming also injects summaries for newly discarded history', async () => {
  const messages = Array.from({ length: 41 }, (_, i) => message(i, `Turno ${i} ${'x'.repeat(240)}`));
  const context = await buildContext({ ...options, messages, maxMessages: 60,
    blockSummaries: [
      { messageIndexFrom: 0, messageIndexTo: 9, content: 'Pasado del primer bloque' },
      { messageIndexFrom: 10, messageIndexTo: 19, content: 'Pasado del segundo bloque' },
    ],
  });
  assert.equal(context.summaryMessage, null); // la ventana por mensajes aún no recorta
  const mandatory = [...context.messages.slice(0, context.prefixCount), ...context.messages.slice(-context.footerCount)];
  const budget = estimateContextTokens(mandatory) + 250;
  const result = trimContextWithSummary(context.messages, budget, {
    prefixCount: context.prefixCount, requiredRecent: context.footerCount,
    summaryMessage: context.summaryMessage, summaryForTrimmed: context.summaryForTrimmed,
  });
  assert.ok(result.trimmed > 0);
  assert.ok(result.estimatedTokens <= budget);
  const text = result.messages.map((m) => m.content).join('\n');
  assert.match(text, /Pasado del primer bloque/);
  assert.match(text, /Pasado del segundo bloque/);
  assert.equal(result.messages.at(-1)?.content, messages.at(-1)?.content);
});

test('scene anchor restates location, present and the player action at the generation point', async () => {
  const messages = [message(0), message(1), message(2, 'Ataca al dragón con la espada')];
  const result = await buildContext({
    ...options, messages, currentLocation: 'Cueva del dragón',
    sceneState: {
      situacion: 'El jugador ataca al dragón', tension: 'Alta: combate',
      characters: { aria: { quiere: 'derrotar al dragón', preocupa: 'sus heridas', pendiente: '', impresion: '' } },
      npcs: [{ nombre: 'Dragón', rasgo: 'feroz', estado: 'furioso', conoceAlJugador: true }],
      updatedAtIndex: 2, updatedAt: '',
    },
  });
  const footer = result.messages.slice(-result.footerCount);
  const anchor = footer[footer.length - 2]; // justo antes del último mensaje del jugador
  assert.equal(anchor.role, 'system');
  assert.match(anchor.content, /Cueva del dragón/);
  assert.match(anchor.content, /Aria, Dragón/);
  assert.match(anchor.content, /El jugador acaba de hacer esto: Ataca al dragón con la espada/);
  assert.match(anchor.content, /No recapitules el pasado/);
});

test('relevance keeps only threads, memories and events connected to the current action', async () => {
  const prov = new ProviderRepository().create({
    name: 'embeddings', type: 'openai', baseUrl: 'http://test/v1', apiKey: null,
    defaultModel: 'emb-model', isEnabled: true, config: {},
  });
  const insertMemory = (id: string, type: string, content: string, importance: number) =>
    db.run(sql`INSERT INTO memory_entries (id, conversation_id, character_id, type, content, importance, is_active, created_at, updated_at)
               VALUES (${id}, 'test', 'aria', ${type}, ${content}, ${importance}, 1, '2026-01-01', '2026-01-01')`);
  insertMemory('mem1', 'fact', 'El dragón guardaba un tesoro maldito', 8);
  insertMemory('mem2', 'fact', 'El herrero le debe un yelmo', 7);
  insertMemory('mem3', 'offense', 'El herrero la insultó en la plaza', 9);

  const story: Story = {
    id: 's1', userId: null, ownerName: null, name: 'La cueva', description: '',
    globalContext: '', narrativeRules: '', worldLore: '',
    persistentEvents: [
      { id: 'e1', title: 'El dragón despierta', description: 'El dragón ataca sin piedad', trigger: 'el jugador ataca al dragón', importance: 8, timestamp: '' },
      { id: 'e2', title: 'Fiesta en el pueblo', description: 'El pueblo celebra', trigger: 'el jugador llega al pueblo', importance: 5, timestamp: '' },
    ],
    locations: [], stateVariables: {}, behaviorRestrictions: [], isActive: true,
    adventureMode: false, openWorld: false, deathMode: false, calendar: null,
    characters: [], createdAt: '', updatedAt: '',
  };
  const thread = (id: string, title: string, description: string): NarrativeThread => ({
    id, conversationId: 'test', title, description, status: 'open',
    importance: 8, openedAtIndex: 0, closedAtIndex: null, createdAt: '', updatedAt: '',
  });

  // Embeddings deterministas: todo lo que menciona al dragón es "relevante".
  const stub = mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(init?.body as string) as { input: string[] };
    return Response.json({
      data: body.input.map((t, i) => ({ index: i, embedding: t.includes('dragón') ? [1, 0] : [0, 1] })),
    });
  });
  try {
    const result = await buildContext({
      ...options, stories: [story],
      messages: [message(0), message(1), message(2, 'Ataca al dragón')],
      occurredEventIds: new Set<string>(),
      openThreads: [thread('t1', 'La maldición del dragón', 'El dragón está maldito'),
                    thread('t2', 'La deuda con el herrero', 'Falta pagar el yelmo')],
      embeddingEnabled: true, embeddingProviderId: prov.id, embeddingModel: 'emb-model',
    });
    const text = result.messages.map((m) => m.content).join('\n');
    // Hilos: el relevante se lista; el irrelevante se oculta con nota.
    assert.match(text, /La maldición del dragón/);
    assert.doesNotMatch(text, /La deuda con el herrero/);
    assert.match(text, /no los traigas este turno/);
    // Memorias: el hecho relevante y la ofensa (emocional, exenta) se inyectan;
    // el hecho irrelevante se filtra.
    assert.match(text, /tesoro maldito/);
    assert.doesNotMatch(text, /yelmo/);
    assert.match(text, /la insultó/);
    // Eventos: solo el relevante es destino inmediato; el otro no se menciona.
    assert.match(text, /El dragón despierta/);
    assert.doesNotMatch(text, /Fiesta en el pueblo/);
  } finally {
    stub.mock.restore();
  }
});

test('without embeddings, lexical overlap with the current action still filters', async () => {
  const story: Story = {
    id: 's2', userId: null, ownerName: null, name: 'Sin embeddings', description: '',
    globalContext: '', narrativeRules: '', worldLore: '',
    persistentEvents: [
      { id: 'e1', title: 'Fiesta en el pueblo', description: 'El pueblo celebra', trigger: 'el jugador llega al pueblo', importance: 5, timestamp: '' },
    ],
    locations: [], stateVariables: {}, behaviorRestrictions: [], isActive: true,
    adventureMode: false, openWorld: false, deathMode: false, calendar: null,
    characters: [], createdAt: '', updatedAt: '',
  };
  const base = {
    ...options, stories: [story],
    occurredEventIds: new Set<string>(),
    openThreads: [{ id: 't1', conversationId: 'test', title: 'La deuda con el herrero', description: 'Falta pagar el yelmo', status: 'open' as const, importance: 8, openedAtIndex: 0, closedAtIndex: null, createdAt: '', updatedAt: '' }],
    // Sin proveedor de embeddings: no hay llamadas extra, filtra el solapamiento léxico.
    embeddingEnabled: true, embeddingProviderId: null, embeddingModel: null,
  };
  // Acción clara: el hilo y el evento ajenos a "dragón" se filtran.
  const filtered = await buildContext({ ...base, messages: [message(0), message(1), message(2, 'Ataca al dragón')] });
  const text = filtered.messages.map((m) => m.content).join('\n');
  assert.doesNotMatch(text, /La deuda con el herrero/);
  assert.doesNotMatch(text, /Fiesta en el pueblo/);
  assert.match(text, /no los traigas este turno/);
  // Sin señal (mensaje demasiado corto): no se recorta a ciegas, se inyecta todo.
  const full = await buildContext({ ...base, messages: [message(0), message(1), message(2, 'Sigo.')] });
  const fullText = full.messages.map((m) => m.content).join('\n');
  assert.match(fullText, /La deuda con el herrero/);
  assert.match(fullText, /Fiesta en el pueblo/);
});
