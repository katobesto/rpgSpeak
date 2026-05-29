import { ConversationRepository } from './conversation.repository.js';
import { NotFoundError } from '../../shared/errors.js';
import type { Conversation } from '@rpgspeak/shared';
import type { CreateConversationInput, UpdateConversationInput } from './conversation.schema.js';
import { triggerSummaryUpdate as engineTriggerSummaryUpdate } from '../../core/conversation/engine.js';

const repo = new ConversationRepository();

export class ConversationService {
  list(params: {
    includeArchived?: boolean;
    userId?: string;
    isAdmin?: boolean;
    search?: string;
    characterId?: string;
    storyId?: string;
    filterUserId?: string;
  } = {}): Conversation[] {
    return repo.findAll(params);
  }

  get(id: string): Conversation {
    const conv = repo.findById(id);
    if (!conv) throw new NotFoundError('Conversation', id);
    return conv;
  }

  create(input: CreateConversationInput, userId?: string): Conversation {
    return repo.create({
      title: input.title,
      mode: input.mode,
      characterIds: input.characterIds,
      storyIds: input.storyIds,
      userId,
    });
  }

  update(id: string, input: UpdateConversationInput): Conversation {
    this.get(id);
    return repo.update(id, input)!;
  }

  delete(id: string): void {
    this.get(id);
    repo.delete(id);
  }

  async triggerSummaryUpdate(id: string): Promise<Conversation> {
    this.get(id); // throws if not found
    return engineTriggerSummaryUpdate(id);
  }
}

export { repo as conversationRepo };
