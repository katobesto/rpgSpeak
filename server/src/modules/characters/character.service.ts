import { CharacterRepository } from './character.repository.js';
import { createCharacterSchema } from './character.schema.js';
import { NotFoundError, ValidationError } from '../../shared/errors.js';
import type { Character } from '@rpgspeak/shared';
import type { CreateCharacterInput, UpdateCharacterInput } from './character.schema.js';
import { SettingsService } from '../settings/settings.service.js';
import { ProviderRepository } from '../providers/provider.repository.js';
import { createProvider } from '../../core/llm/provider.factory.js';
import type { GenerateRequest } from '@rpgspeak/shared';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// server/src/modules/characters/ → go up 4 levels to project root
const PROJECT_ROOT = path.resolve(__dirname, '../../../../');

const repo = new CharacterRepository();
const settingsService = new SettingsService();
const providerRepo = new ProviderRepository();

export class CharacterService {
  list(search?: string, userId?: string, isAdmin = false, storyId?: string): Character[] {
    return repo.findAll(search, userId, isAdmin, storyId);
  }

  get(id: string): Character {
    const character = repo.findById(id);
    if (!character) throw new NotFoundError('Character', id);
    return character;
  }

  create(input: CreateCharacterInput, userId?: string): Character {
    return repo.create({
      name: input.name,
      avatar: input.avatar ?? null,
      description: input.description,
      personality: input.personality,
      systemPrompt: input.systemPrompt,
      lore: input.lore,
      exampleDialogue: input.exampleDialogue,
      tags: input.tags,
      temperature: input.temperature,
      modelId: input.modelId ?? null,
      providerId: input.providerId ?? null,
      contextLength: input.contextLength,
      memoryEnabled: input.memoryEnabled,
      memoryType: input.memoryType,
      memoryWindow: input.memoryWindow,
      llmParams: input.llmParams,
      relations: input.relations,
      rpgStats: input.rpgStats ?? {},
      imageDescription: input.imageDescription ?? null,
      gallery: input.gallery ?? [],
    }, userId);
  }

  update(id: string, input: UpdateCharacterInput): Character {
    this.get(id);
    return repo.update(id, input)!;
  }

  delete(id: string): void {
    this.get(id);
    repo.delete(id);
  }

  duplicate(id: string): Character {
    this.get(id);
    return repo.duplicate(id)!;
  }

  importFromJson(data: unknown): Character {
    const result = createCharacterSchema.safeParse(data);
    if (!result.success) {
      throw new ValidationError(result.error.issues[0].message);
    }
    return this.create(result.data);
  }

  async generateImageDescription(
    id: string,
    overrides?: { providerId?: string; modelId?: string },
  ): Promise<{ description: string }> {
    const character = this.get(id);
    const settings = settingsService.getAll();

    const providerId =
      overrides?.providerId ??
      character.providerId ??
      settings.defaultProviderId ??
      'default-ollama';
    const provider = providerRepo.findById(providerId);
    if (!provider || !provider.isEnabled) {
      throw new ValidationError('No hay un proveedor LLM configurado o habilitado.');
    }

    const modelId =
      overrides?.modelId ??
      character.modelId ??
      provider.defaultModel ??
      settings.defaultModelId;
    if (!modelId) {
      throw new ValidationError('No hay un modelo configurado. Ve a Settings y selecciona un modelo.');
    }

    const promptTemplate = settings.charImagePrompt;
    const prompt = promptTemplate
      .replace('{{nombre}}',      character.name        ?? '')
      .replace('{{descripcion}}', character.description ?? '')
      .replace('{{personalidad}}', character.personality ?? '')
      .replace('{{lore}}',        character.lore        ?? '');

    const llm = createProvider(provider);
    const request: GenerateRequest = {
      messages: [
        { role: 'user', content: prompt },
      ],
      model: modelId,
      temperature: 0.7,
      stream: false,
    };

    const response = await llm.generate(request);
    return { description: response.content.trim() };
  }

  addImage(id: string, data: string, filename: string, setAsAvatar?: boolean): Character {
    const character = this.get(id);

    // Strip data URL prefix if present
    const base64 = data.replace(/^data:[^;]+;base64,/, '');

    const ext = path.extname(filename).toLowerCase() || '.jpg';
    const newFilename = `${uuidv4()}${ext}`;
    const dirPath = path.join(PROJECT_ROOT, 'data', 'images', 'chars', id);
    fs.mkdirSync(dirPath, { recursive: true });

    const filePath = path.join(dirPath, newFilename);
    fs.writeFileSync(filePath, Buffer.from(base64, 'base64'));

    const imagePath = `/images/chars/${id}/${newFilename}`;
    const gallery = [...(character.gallery ?? []), imagePath];

    const updates: Partial<Omit<Character, 'id' | 'createdAt' | 'updatedAt'>> = { gallery };
    if (setAsAvatar) {
      updates.avatar = imagePath;
    }

    return repo.update(id, updates)!;
  }

  removeImage(id: string, imagePath: string): Character {
    const character = this.get(id);
    const gallery = (character.gallery ?? []).filter((p) => p !== imagePath);

    // Delete file from disk
    const relPath = imagePath.replace(/^\/images\//, '');
    const filePath = path.join(PROJECT_ROOT, 'data', 'images', relPath);
    try { fs.unlinkSync(filePath); } catch { /* file may not exist */ }

    const updates: Partial<Omit<Character, 'id' | 'createdAt' | 'updatedAt'>> = { gallery };
    if (character.avatar === imagePath) {
      updates.avatar = null;
    }

    return repo.update(id, updates)!;
  }
}
