import type { ChatMessage } from '@rpgspeak/shared';

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

/**
 * Trims conversation history to fit within maxTokens budget.
 * Always preserves the leading system message(s) and the most recent N messages.
 * Drops oldest messages from the middle first.
 *
 * IMPORTANT: only the leading contiguous block of system messages is treated as
 * "header" (moved to the front). System messages interspersed in the conversation
 * body (e.g. memory injection just before the last user message) keep their
 * relative position — they are NOT pulled out and reordered.
 *
 * Recorte cuantizado (estabilidad del prefix-cache): recortar "lo mínimo para
 * caber" mueve el punto de corte en CADA turno una vez desbordado el presupuesto,
 * invalidando el prefix-cache del provider en todos los turnos siguientes. En su
 * lugar, el número de mensajes descartados se redondea hacia arriba al múltiplo
 * de TRIM_STEP: el punto de corte queda fijo durante ~TRIM_STEP turnos entre
 * salto y salto. El sobrecoste es descartar hasta TRIM_STEP-1 mensajes antes de
 * lo estrictamente necesario — barato comparado con perder el caché del historial
 * completo turno tras turno.
 */
const TRIM_STEP = 8;

export function trimContext(messages: ChatMessage[], maxTokens: number, preserveRecent = 6): TrimResult {
  if (estimateContextTokens(messages) <= maxTokens) {
    return { messages, trimmed: 0, estimatedTokens: estimateContextTokens(messages) };
  }

  // Separate the leading "header" system messages from the conversation body.
  // Any system message that appears AFTER the first user/assistant message is
  // considered "inline" and stays in the body (preserving its position).
  let bodyStart = 0;
  while (bodyStart < messages.length && messages[bodyStart].role === 'system') {
    bodyStart++;
  }
  const headerMessages = messages.slice(0, bodyStart);
  const body = messages.slice(bodyStart); // may contain inline system messages

  const headerTokens = estimateContextTokens(headerMessages);
  const budget = maxTokens - headerTokens;

  // Always keep the most recent N items from the body (includes inline system msgs)
  const preserved = body.slice(-preserveRecent);
  const trimable = body.slice(0, -preserveRecent);

  // Pass 1 — minimal drop: walk from most-recent trimable backwards until the
  // budget is exhausted; whatever doesn't fit is the minimal number to drop.
  let currentTokens = estimateContextTokens(preserved);
  let minimalDrop = trimable.length;
  for (let i = trimable.length - 1; i >= 0; i--) {
    const msgTokens = estimateTokens(trimable[i].content) + 4;
    if (currentTokens + msgTokens <= budget) {
      currentTokens += msgTokens;
      minimalDrop--;
    } else {
      break;
    }
  }

  // Pass 2 — quantize: round the drop count up to the next multiple of TRIM_STEP
  // so the cut point stays stable across turns (see comment above).
  const trimmed = Math.min(trimable.length, Math.ceil(minimalDrop / TRIM_STEP) * TRIM_STEP);
  const kept = trimable.slice(trimmed);

  const result = [...headerMessages, ...kept, ...preserved];
  return {
    messages: result,
    trimmed,
    estimatedTokens: estimateContextTokens(result),
  };
}
