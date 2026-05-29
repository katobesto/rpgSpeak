import { StoryRepository } from './story.repository.js';
import { NotFoundError } from '../../shared/errors.js';
import type { Story } from '@rpgspeak/shared';
import type { CreateStoryInput, UpdateStoryInput } from './story.schema.js';

const repo = new StoryRepository();

export class StoryService {
  list(params: {
    search?: string;
    text?: string;
    userId?: string;
    isAdmin?: boolean;
    characterId?: string;
    filterUserId?: string;
  } = {}): Story[] {
    return repo.findAll(params);
  }

  get(id: string): Story {
    const story = repo.findById(id);
    if (!story) throw new NotFoundError('Story', id);
    return story;
  }

  create(input: CreateStoryInput, userId?: string): Story {
    return repo.create(input, userId);
  }

  update(id: string, input: UpdateStoryInput): Story {
    this.get(id);
    return repo.update(id, input)!;
  }

  delete(id: string): void {
    this.get(id);
    repo.delete(id);
  }
}
