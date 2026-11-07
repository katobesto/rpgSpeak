import type { ChatMessage } from '@rpgspeak/shared';
import { ValidationError } from '../../shared/errors.js';

/**
 * Estimates token count using the ~4 chars/token heuristic.
 * Accurate enough for trimming decisions; avoids heavy tokenizer deps.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function estimateContextTokens(messages: ChatMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateTokens(m.content) + 4, 0);
}

export interface TrimResult {
  messages: ChatMessage[];
  trimmed: number;
  estimatedTokens: number;
}

interface TrimOptions {
  /** Footer completo, incluido el mensaje actual: nunca se descarta. */
  requiredRecent?: number;
  /** Sistema y ejemplos estables, para conservar también su caché. */
  prefixCount?: number;
}

const TRIM_STEP = 8;

/** Recorte escalonado. preserveRecent es una preferencia; el prefijo y el
 * footer son obligatorios. No devolver prompts que excedan el presupuesto. */
export function trimContext(messages: ChatMessage[], maxTokens: number, preserveRecent = 6, options: TrimOptions = {}): TrimResult {
  const total = estimateContextTokens(messages);
  if (total <= maxTokens) return { messages, trimmed: 0, estimatedTokens: total };

  let bodyStart = options.prefixCount ?? 0;
  while (bodyStart < messages.length && messages[bodyStart].role === 'system') bodyStart++;
  const header = messages.slice(0, bodyStart);
  const body = messages.slice(bodyStart);
  const requiredRecent = Math.min(body.length, Math.max(1, options.requiredRecent ?? 1));
  const budget = maxTokens - estimateContextTokens(header);
  if (estimateContextTokens(body.slice(-requiredRecent)) > budget) {
    throw new ValidationError('El contexto fijo y el mensaje actual superan el presupuesto. Aumenta la ventana de contexto o reduce lore, notas y directivas.');
  }

  let keep = Math.min(body.length, Math.max(requiredRecent, preserveRecent));
  while (keep > requiredRecent && estimateContextTokens(body.slice(-keep)) > budget) keep--;
  const preserved = body.slice(-keep);
  const trimmable = body.slice(0, body.length - keep);
  let currentTokens = estimateContextTokens(preserved);
  let minimalDrop = trimmable.length;
  for (let i = trimmable.length - 1; i >= 0; i--) {
    const tokens = estimateTokens(trimmable[i].content) + 4;
    if (currentTokens + tokens > budget) break;
    currentTokens += tokens;
    minimalDrop--;
  }

  let trimmed = Math.min(trimmable.length, Math.ceil(minimalDrop / TRIM_STEP) * TRIM_STEP);
  // No empezar el historial por una respuesta huérfana. No tocar el footer.
  if (body[trimmed]?.role === 'assistant' && trimmed < body.length - requiredRecent) trimmed++;
  const result = [...header, ...body.slice(trimmed)];
  return { messages: result, trimmed, estimatedTokens: estimateContextTokens(result) };
}

/** Ajusta los resúmenes al corte real por tokens, además del corte por número
 * de mensajes. Si el resumen ocupa más espacio, recorta otra vez sin recuperar
 * historial ya descartado: el proceso es monótono y termina. */
export function trimContextWithSummary(messages: ChatMessage[], maxTokens: number, options: Required<TrimOptions> & {
  summaryMessage: ChatMessage | null;
  summaryForTrimmed: (additionalTrimmed: number) => ChatMessage | null;
}): TrimResult {
  let working = messages;
  let summaryMessage = options.summaryMessage;
  let requiredRecent = options.requiredRecent;
  let totalTrimmed = 0;
  for (;;) {
    const result = trimContext(working, maxTokens, requiredRecent + 6, { prefixCount: options.prefixCount, requiredRecent });
    totalTrimmed += result.trimmed;
    const nextSummary = options.summaryForTrimmed(totalTrimmed);
    if (nextSummary?.content === summaryMessage?.content) return { ...result, trimmed: totalTrimmed };
    working = [...result.messages];
    const oldIndex = summaryMessage ? working.indexOf(summaryMessage) : -1;
    if (oldIndex !== -1) {
      working.splice(oldIndex, 1, ...(nextSummary ? [nextSummary] : []));
      if (!nextSummary) requiredRecent--;
    } else if (nextSummary) {
      working.splice(working.length - requiredRecent, 0, nextSummary);
      requiredRecent++;
    }
    summaryMessage = nextSummary;
  }
}
