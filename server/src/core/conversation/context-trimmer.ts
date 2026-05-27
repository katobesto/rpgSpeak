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
 */
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

  let currentTokens = estimateContextTokens(preserved);
  const kept: ChatMessage[] = [];
  let trimmed = trimable.length;

  // Add from most-recent trimable backwards until budget exhausted
  for (let i = trimable.length - 1; i >= 0; i--) {
    const msgTokens = estimateTokens(trimable[i].content) + 4;
    if (currentTokens + msgTokens <= budget) {
      kept.unshift(trimable[i]);
      currentTokens += msgTokens;
      trimmed--;
    } else {
      break;
    }
  }

  const result = [...headerMessages, ...kept, ...preserved];
  return {
    messages: result,
    trimmed,
    estimatedTokens: estimateContextTokens(result),
  };
}
