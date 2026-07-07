/**
 * context-extractor.ts
 *
 * Shared logic for extracting narrative context items from a batch of messages.
 * Used by:
 *  - context.routes.ts  → manual extraction triggered by the user
 *  - engine.ts          → automatic fire-and-forget extraction after each response
 */

import { ContextRepository }      from '../../modules/context/context.repository.js';
import { stripOocNotes }          from '../conversation/ooc.js';
import { MessageRepository }      from '../../modules/messages/message.repository.js';
import { ConversationRepository } from '../../modules/conversations/conversation.repository.js';
import { CharacterRepository }    from '../../modules/characters/character.repository.js';
import { StoryRepository }        from '../../modules/stories/story.repository.js';
import { ProviderRepository }     from '../../modules/providers/provider.repository.js';
import { SettingsService }        from '../../modules/settings/settings.service.js';
import { createProvider }         from '../llm/provider.factory.js';
import type { Message }           from '@rpgspeak/shared';

// ── Constants ─────────────────────────────────────────────────────────────────

// Truncate each message to limit tokens per batch
const MAX_MSG_CHARS = 350;

// Tag pattern — [TIPO:title|description|importance]
const TAG_RE = /\[(EVENTO|PERSONAJE|LUGAR|CONQUISTA):([^\]|]+)\|([^\]|]+)\|(\d+)\]/g;
const TYPE_MAP: Record<string, 'event' | 'character' | 'place' | 'quest'> = {
  EVENTO:    'event',
  PERSONAJE: 'character',
  LUGAR:     'place',
  CONQUISTA: 'quest',
};

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ExtractOptions {
  conversationId: string;
  batchStart:     number;
  /** How many messages to process in one batch (default: 50 for auto, 100 for manual). */
  batchSize?:     number;
  providerId:     string;
  modelId:        string | null;
}

export interface ExtractResult {
  itemCount:  number;
  batchStart: number;
  batchEnd:   number;
  totalMessages: number;
  skipped: boolean;   // true when batch is empty (nothing new to extract)
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildPrompt(
  batch:           Message[],
  batchStart:      number,
  totalMessages:   number,
  charNameMap:     Map<string, string>,
  promptTemplate:  string,
  knownChars:      string,
  knownStories:    string,
): string {
  const batchEnd = batchStart + batch.length;
  const lines = batch.map((m) => {
    let speaker = 'Usuario';
    if (m.role === 'assistant') {
      speaker = m.characterId
        ? (charNameMap.get(m.characterId) ?? 'Personaje')
        : 'Narrador';
    }
    let content = m.content
      .replace(/\[AFINIDAD:[^\]]+\]/g, '')
      .replace(/\[MEMORIA:[^\]]+\]/g,  '');
    // Notas OOC del jugador (paréntesis): no son hechos del mundo → fuera del índice.
    if (m.role === 'user') content = stripOocNotes(content);
    content = content.trim().slice(0, MAX_MSG_CHARS);
    return `${speaker}: ${content}`;
  });

  return promptTemplate
    .replace('{{fragmento}}',            lines.join('\n\n'))
    .replace('{{desde}}',                String(batchStart + 1))
    .replace('{{hasta}}',                String(batchEnd))
    .replace('{{total}}',                String(totalMessages))
    .replace('{{personajes_conocidos}}', knownChars  || '(ninguno)')
    .replace('{{historias_conocidas}}',  knownStories || '(ninguno)');
}

function parseItems(text: string) {
  const items: Array<{
    type:        'event' | 'character' | 'place' | 'quest';
    title:       string;
    description: string;
    importance:  number;
  }> = [];
  for (const m of text.matchAll(TAG_RE)) {
    const type = TYPE_MAP[m[1]];
    const title       = m[2].trim();
    const description = m[3].trim();
    const importance  = Math.min(10, Math.max(1, parseInt(m[4], 10)));
    if (type && title) items.push({ type, title, description, importance });
  }
  return items;
}

// ── Core extraction ───────────────────────────────────────────────────────────

/**
 * Extracts context items from a slice of the conversation's message history,
 * persists them, and optionally computes embeddings.
 *
 * Returns a summary of what was done.
 */
export async function extractContextBatch(opts: ExtractOptions): Promise<ExtractResult> {
  const { conversationId, batchStart, providerId, modelId } = opts;
  const batchSize = opts.batchSize ?? 50;

  const ctxRepo   = new ContextRepository();
  const msgRepo   = new MessageRepository();
  const convRepo  = new ConversationRepository();
  const charRepo  = new CharacterRepository();
  const storyRepo = new StoryRepository();
  const provRepo  = new ProviderRepository();
  const settings  = new SettingsService();

  // Non-system messages only, chronological
  const allMsgs = msgRepo
    .findByConversation(conversationId)
    .filter((m) => m.role !== 'system');
  const totalMessages = allMsgs.length;

  const batch = allMsgs.slice(batchStart, batchStart + batchSize);
  if (batch.length === 0) {
    return { itemCount: 0, batchStart, batchEnd: batchStart, totalMessages, skipped: true };
  }
  const batchEnd = batchStart + batch.length;

  // Build character / story context for the prompt
  const conversation = convRepo.findById(conversationId);
  const charMap = new Map<string, string>();
  const knownCharLines:  string[] = [];
  const knownStoryLines: string[] = [];

  if (conversation) {
    for (const link of conversation.characters) {
      const char = charRepo.findById(link.characterId);
      if (!char) continue;
      charMap.set(char.id, char.name);
      knownCharLines.push(`- ${char.name}`);
    }
    for (const link of conversation.stories) {
      const story = storyRepo.findById(link.storyId);
      if (!story) continue;
      knownStoryLines.push(`- ${story.name}`);
    }
  }

  const provider = provRepo.findById(providerId);
  if (!provider?.isEnabled) {
    return { itemCount: 0, batchStart, batchEnd, totalMessages, skipped: true };
  }
  const llm = createProvider(provider);

  const promptTemplate = settings.get('contextIndexPrompt') as string;
  const contextSize    = (settings.get('contextIndexContextSize') as number | null) ?? 8192;

  const prompt = buildPrompt(
    batch, batchStart, totalMessages, charMap,
    promptTemplate,
    knownCharLines.join('\n'),
    knownStoryLines.join('\n'),
  );

  const result = await llm.generate({
    messages: [
      {
        role:    'system',
        content: 'Eres un cronista de historias de rol. Responde SOLO con las etiquetas indicadas, sin texto adicional.',
      },
      { role: 'user', content: prompt },
    ],
    model:       modelId ?? '',
    temperature: 0.15,
    maxTokens:   1500,
    contextSize,
    stream:      false,
  });

  const parsed  = parseItems(result.content);
  const created = parsed.map((p) =>
    ctxRepo.create({ conversationId, ...p, messageIndexFrom: batchStart, messageIndexTo: batchEnd })
  );

  // ── Compute embeddings if configured (non-fatal) ──
  const s = settings.getAll();
  if (s.embeddingEnabled && s.embeddingProviderId && s.embeddingModel && created.length > 0) {
    const embProv = provRepo.findById(s.embeddingProviderId);
    if (embProv?.isEnabled) {
      const embLlm = createProvider(embProv);
      if (embLlm.embed) {
        try {
          const texts = created.map((i) => `${i.title}: ${i.description}`);
          const vecs  = await embLlm.embed(texts, s.embeddingModel);
          for (let j = 0; j < created.length; j++) {
            if (vecs[j]?.length > 0) {
              ctxRepo.updateEmbedding(created[j].id, new Float32Array(vecs[j]), s.embeddingModel);
            }
          }
        } catch (e) {
          console.warn('[context-extractor] Embedding failed (non-fatal):', e instanceof Error ? e.message : e);
        }
      }
    }
  }

  return { itemCount: created.length, batchStart, batchEnd, totalMessages, skipped: false };
}

// ── Auto-extraction (fire-and-forget entry point) ─────────────────────────────

/**
 * Called automatically after each assistant response.
 * Checks if enough new messages have accumulated since the last extraction,
 * and if so, runs a background extraction without blocking the response.
 */
export async function autoExtractContextAsync(
  conversationId:    string,
  currentMessageCount: number,
): Promise<void> {
  try {
    const settings  = new SettingsService();
    const s         = settings.getAll();

    if (!s.contextAutoExtractEnabled) return;

    const interval = s.contextAutoExtractInterval ?? 8;
    const ctxRepo  = new ContextRepository();

    // Where the last extraction left off
    const lastExtracted = ctxRepo.findMaxMessageIndexTo(conversationId);
    const pendingCount  = currentMessageCount - lastExtracted;

    if (pendingCount < interval) return;

    // Provider selection: dedicated > fast LLM > default
    const provRepo = new ProviderRepository();
    let providerId: string | null = null;
    let modelId:    string | null = null;

    if (s.contextAutoExtractProviderId) {
      providerId = s.contextAutoExtractProviderId;
      modelId    = s.contextAutoExtractModelId ?? null;
    } else if (s.fastLlmEnabled && s.fastLlmProviderId) {
      providerId = s.fastLlmProviderId;
      modelId    = s.fastLlmModelId ?? null;
    } else if (s.defaultProviderId) {
      providerId = s.defaultProviderId;
      modelId    = s.defaultModelId ?? null;
    }

    if (!providerId) return;

    const result = await extractContextBatch({
      conversationId,
      batchStart: lastExtracted,
      batchSize:  50,
      providerId,
      modelId,
    });

    if (!result.skipped) {
      console.log(
        `[context-auto] ${result.itemCount} items extracted for conv ${conversationId}` +
        ` (msgs ${result.batchStart + 1}–${result.batchEnd}/${result.totalMessages})`
      );
    }
  } catch (err) {
    // Non-fatal: auto-extraction is best-effort
    console.warn('[context-auto] Failed (non-fatal):', err instanceof Error ? err.message : err);
  }
}
