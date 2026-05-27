import { MessageRepository } from './message.repository.js';
import { NotFoundError, ValidationError } from '../../shared/errors.js';
import { ConversationRepository } from '../conversations/conversation.repository.js';
import type { Message } from '@rpgspeak/shared';
import { config } from '../../config.js';

const repo = new MessageRepository();
const convRepo = new ConversationRepository();

export class MessageService {
  list(conversationId: string, branchId?: string): Message[] {
    return repo.findByConversation(conversationId, branchId);
  }

  get(id: string): Message {
    const msg = repo.findById(id);
    if (!msg) throw new NotFoundError('Message', id);
    return msg;
  }

  create(data: {
    conversationId: string;
    role: Message['role'];
    content: string;
    characterId?: string;
    parentId?: string;
    tokens?: number;
    metadata?: Record<string, unknown>;
  }): Message {
    if (data.content.length > config.limits.maxMessageLength) {
      throw new ValidationError(`Message exceeds maximum length of ${config.limits.maxMessageLength} characters`);
    }
    const msg = repo.create(data);
    convRepo.incrementCounts(data.conversationId, data.tokens ?? 0);
    return msg;
  }

  update(id: string, data: { content?: string }): Message {
    this.get(id);
    return repo.update(id, data)!;
  }

  delete(id: string): void {
    this.get(id);
    repo.delete(id);
  }

  branch(messageId: string): { branchId: string } {
    const msg = this.get(messageId);
    repo.deactivateBranch(msg.conversationId, messageId);
    const newBranchId = `branch-${Date.now()}`;
    return { branchId: newBranchId };
  }
}

export { repo as messageRepo };
