import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import type { GenerateRequest } from '@rpgspeak/shared';
import { OpenAIProvider } from '../src/core/llm/providers/openai.provider.js';
import { OllamaProvider } from '../src/core/llm/providers/ollama.provider.js';
import { KoboldProvider } from '../src/core/llm/providers/kobold.provider.js';
import type { LLMProvider } from '../src/core/llm/provider.interface.js';

const request: GenerateRequest = {
  model: 'qwen-local', stream: false, temperature: 0,
  messages: [{ role: 'system', content: 'Reglas estables' }, { role: 'user', content: 'Hola' }],
  repetitionPenalty: 1.12, frequencyPenalty: 0.35, presencePenalty: 0.15,
  topP: 0.9, contextSize: 40960, stopSequences: ['STOP'],
};

async function capture(provider: LLMProvider, input = request, stream = false) {
  let body: Record<string, unknown> = {};
  const stub = mock.method(globalThis, 'fetch', async (_url: unknown, options: RequestInit) => {
    body = JSON.parse(options.body as string);
    if (stream) return new Response(provider.type === 'ollama'
      ? '{"message":{"content":"ok"},"done":true}\n'
      : 'data: [DONE]\n\n');
    return Response.json({
      model: input.model, choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      message: { content: 'ok' }, results: [{ text: 'ok' }],
    });
  });
  try {
    if (stream) { for await (const token of provider.stream(input)) assert.equal(typeof token, 'string'); }
    else await provider.generate(input);
    return body;
  } finally { stub.mock.restore(); }
}

for (const stream of [false, true]) {
  for (const type of ['openai', 'lmstudio', 'mlx', 'openrouter', 'oobabooga', 'custom']) {
    test(`${type}: independent sampling parameters, temperature zero (${stream ? 'stream' : 'generate'})`, async () => {
      const body = await capture(new OpenAIProvider({ baseUrl: 'http://test/v1' }, type), request, stream);
      assert.equal(body.temperature, 0);
      assert.equal(body.frequency_penalty, 0.35);
      assert.equal(body.presence_penalty, 0.15);
      if (type === 'lmstudio') assert.equal(body.repeat_penalty, 1.12);
      else if (['mlx', 'openrouter', 'oobabooga'].includes(type)) assert.equal(body.repetition_penalty, 1.12);
      else {
        assert.equal(body.repetition_penalty, undefined);
        assert.equal(body.repeat_penalty, undefined);
      }
      if (stream) assert.deepEqual(body.stream_options, { include_usage: true });
    });
  }
  test(`Ollama maps all three penalties (${stream})`, async () => {
    const body = await capture(new OllamaProvider({ baseUrl: 'http://test' }), request, stream);
    const options = body.options as Record<string, unknown>;
    assert.equal(options.temperature, 0);
    assert.equal(options.repeat_penalty, 1.12);
    assert.equal(options.frequency_penalty, 0.35);
    assert.equal(options.presence_penalty, 0.15);
  });
  test(`Kobold keeps multiplicative penalty separate (${stream})`, async () => {
    const body = await capture(new KoboldProvider({ baseUrl: 'http://test' }), request, stream);
    assert.equal(body.temperature, 0);
    assert.equal(body.rep_pen, 1.12);
    assert.equal(body.max_context_length, 40960);
    assert.deepEqual(body.stop_sequence, ['STOP']);
    assert.equal(body.frequency_penalty, undefined);
  });
}

test('LM Studio keeps the stable prefix and history when dynamic footer changes', async () => {
  const provider = new OpenAIProvider({ baseUrl: 'http://test/v1' }, 'lmstudio');
  const history = [...request.messages, { role: 'assistant' as const, content: 'Respuesta anterior' }];
  const before = JSON.stringify(history);
  const make = async (affinity: number) => (await capture(provider, {
    ...request, messages: [...history,
      { role: 'system', content: `Afinidad: ${affinity}` },
      { role: 'system', content: 'Ubicación: taberna' },
      { role: 'user', content: 'Sigue' }],
  })).messages as GenerateRequest['messages'];
  const first = await make(50);
  const second = await make(55);
  assert.deepEqual(first.slice(0, -1), second.slice(0, -1));
  assert.deepEqual(first.slice(0, -1), history);
  assert.deepEqual(first.map((m) => m.role), ['system', 'user', 'assistant', 'user']);
  assert.match(second.at(-1)!.content, /Afinidad: 55/);
  assert.equal(JSON.stringify(history), before);
});

test('local Qwen thinking retains sampling; DeepSeek thinking omits it', async () => {
  const reasoning = { enabled: true, effort: 'high' as const };
  const local = await capture(new OpenAIProvider({ baseUrl: 'http://test' }, 'lmstudio'), { ...request, reasoning });
  assert.equal(local.temperature, 0);
  assert.equal(local.repeat_penalty, 1.12);
  assert.equal(local.reasoning_effort, 'xhigh');
  const deepseek = await capture(new OpenAIProvider({ baseUrl: 'http://test' }), { ...request, model: 'deepseek-v4', reasoning });
  assert.equal(deepseek.temperature, undefined);
  assert.equal(deepseek.frequency_penalty, undefined);
  assert.deepEqual(deepseek.thinking, { type: 'enabled' });
});

test('OpenRouter disables fallback at provider.allow_fallbacks', async () => {
  const body = await capture(new OpenAIProvider({ baseUrl: 'http://test' }, 'openrouter'), { ...request, disableFallbacks: true });
  assert.deepEqual(body.provider, { allow_fallbacks: false });
  assert.equal(body.allow_fallbacks, undefined);
});

test('LM Studio normalizes inline directives, consecutive roles and trailing systems without losing content', async () => {
  const messages: GenerateRequest['messages'] = [
    { role: 'system', content: 'Inicio' }, { role: 'assistant', content: 'Saludo' },
    { role: 'user', content: 'Pregunta' }, { role: 'system', content: 'Nota intermedia' },
    { role: 'assistant', content: 'Respuesta' }, { role: 'assistant', content: 'Continuación' },
    { role: 'system', content: 'Nota final' },
  ];
  const original = JSON.stringify(messages);
  const body = await capture(new OpenAIProvider({ baseUrl: 'http://test' }, 'lmstudio'), { ...request, messages });
  const normalized = body.messages as GenerateRequest['messages'];
  assert.equal(normalized[0].role, 'system');
  for (let i = 1; i < normalized.length; i++) assert.equal(normalized[i].role, i % 2 ? 'user' : 'assistant');
  const combined = normalized.map((m) => m.content).join('\n');
  for (const msg of messages) assert.ok(combined.includes(msg.content));
  assert.equal(JSON.stringify(messages), original);
});

test('Ollama folds footer systems into the last user message (strict HF templates)', async () => {
  const provider = new OllamaProvider({ baseUrl: 'http://test' });
  const body = await capture(provider, {
    ...request,
    messages: [
      { role: 'system', content: 'Reglas estables' },
      { role: 'user', content: 'Hola' },
      { role: 'assistant', content: 'Respuesta anterior' },
      { role: 'system', content: 'Afinidad: 55' },
      { role: 'system', content: 'Ubicación: taberna' },
      { role: 'user', content: 'Sigue' },
    ],
  });
  const msgs = body.messages as { role: string; content: string }[];
  // Un único system en cabecera: el resto viaja pegado al último user, en su
  // posición, para no romper la plantilla (Gemma) ni el prefix-cache.
  assert.equal(msgs.filter((m) => m.role === 'system').length, 1);
  assert.equal(msgs[0].content, 'Reglas estables');
  assert.equal(msgs.at(-1)?.role, 'user');
  assert.match(msgs.at(-1)!.content, /Afinidad: 55[\s\S]*Ubicación: taberna[\s\S]*Sigue/);
});
