import { CharacterRepository } from './character.repository.js';
import { createCharacterSchema } from './character.schema.js';
import { NotFoundError, ValidationError } from '../../shared/errors.js';
import type { Character } from '@rpgspeak/shared';
import type { CreateCharacterInput, UpdateCharacterInput } from './character.schema.js';
import { SettingsService } from '../settings/settings.service.js';
import { ProviderRepository } from '../providers/provider.repository.js';
import { createProvider } from '../../core/llm/provider.factory.js';
import { createImageProvider } from '../../core/image/image-provider.factory.js';
import { DYNAMISM_BLOCK } from '../../core/image/dynamism-block.js';
import type { ImageProgressEvent } from '../../core/image/image-provider.interface.js';
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

  /** Resuelve provider/modelo LLM para un personaje, con overrides puntuales y
   *  fallback a los defaults globales — compartido por generación de descripción
   *  y de escena. */
  private resolveLlmProvider(
    character: Character,
    settings: ReturnType<typeof settingsService.getAll>,
    overrides?: { providerId?: string; modelId?: string },
  ) {
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

    return { provider, modelId };
  }

  /**
   * Construye el prompt de imagen de escena/pose para UN personaje, reutilizando
   * el mismo prompt configurado (sceneImagePrompt) y el mismo apéndice de dinamismo
   * que la generación de escena del chat — en vez del prompt de descripción de
   * personaje (charImagePrompt), más simple. El texto de escena del usuario ocupa
   * el lugar de "THE MOMENT TO DEPICT"; la ficha del personaje (nombre, descripción,
   * imageDescription) alimenta {{characters}}.
   */
  private buildSceneImagePromptText(
    character: Character,
    scenePrompt: string,
    settings: ReturnType<typeof settingsService.getAll>,
  ): string {
    const charBlock = [
      `Name: ${character.name}`,
      character.description ? `Description: ${character.description}` : '',
      character.imageDescription ? `Appearance: ${character.imageDescription}` : '',
    ].filter(Boolean).join('\n');

    const moment = scenePrompt.trim() || 'a natural, neutral portrait pose that reflects their personality';
    const messagesBlock = `>>> THE MOMENT TO DEPICT — build the whole image around THIS beat:\n${character.name}: ${moment}`;

    const filledPrompt = settings.sceneImagePrompt
      .replace('{{characters}}', charBlock || '(no character info available)')
      .replace('{{messages}}',   messagesBlock);

    const constraintBlock =
      `\n\nCRITICAL CONSTRAINT — CHARACTERS IN THE IMAGE:\n` +
      `Only portray ${character.name}. Do NOT portray any other person, character or figure.`;

    return filledPrompt + constraintBlock + DYNAMISM_BLOCK;
  }

  /**
   * Galería con escena/pose libre: el texto de escena del usuario se funde con la
   * ficha del personaje mediante el mismo prompt (y apéndice de dinamismo) que la
   * generación de escena del chat, el LLM configurado lo convierte en un prompt de
   * imagen final, y la imagen se genera usando el avatar del personaje como
   * referencia cuando el proveedor lo soporta, para consistencia visual.
   */
  async generateSceneImage(
    id: string,
    scenePrompt: string,
    overrides?: { providerId?: string; modelId?: string; workflowName?: string },
  ): Promise<{ character: Character; generatedPrompt: string }> {
    const character = this.get(id);
    const settings = settingsService.getAll();
    const { provider, modelId } = this.resolveLlmProvider(character, settings, overrides);

    const llmPrompt = this.buildSceneImagePromptText(character, scenePrompt, settings);

    const llm = createProvider(provider);
    const llmResponse = await llm.generate({
      messages: [{ role: 'user', content: llmPrompt }],
      model: modelId,
      temperature: 0.7,
      stream: false,
    });
    const finalImagePrompt = llmResponse.content.trim();

    const imageProvider = createImageProvider(settings);
    let buffer: Buffer, filename: string;

    const avatarDiskPath = character.avatar
      ? path.join(PROJECT_ROOT, 'data', 'images', character.avatar.replace(/^\/images\//, ''))
      : null;

    if (imageProvider.supportsReference && avatarDiskPath && fs.existsSync(avatarDiskPath)) {
      ({ buffer, filename } = await imageProvider.generateWithReference!({
        prompt: finalImagePrompt,
        referenceImagePath: avatarDiskPath,
        ...(overrides?.workflowName ? { workflowName: overrides.workflowName } : {}),
      }));
    } else {
      ({ buffer, filename } = await imageProvider.generate({
        prompt: finalImagePrompt,
        workflowName: overrides?.workflowName ?? 'image_z_image_turbo',
      }));
    }

    const base64 = buffer.toString('base64');
    const updated = this.addImage(id, base64, filename, false);
    return { character: updated, generatedPrompt: finalImagePrompt };
  }

  /**
   * Igual que generateSceneImage, pero reporta progreso en vivo (status/progress/
   * node/preview) a través de onProgress — usado por la ruta SSE de la galería.
   */
  async generateSceneImageWithProgress(
    id: string,
    scenePrompt: string,
    onEvent: (evt: { type: 'status'; message: string } | ImageProgressEvent) => void,
    overrides?: { providerId?: string; modelId?: string; workflowName?: string },
  ): Promise<{ character: Character; generatedPrompt: string }> {
    const character = this.get(id);
    const settings = settingsService.getAll();
    const { provider, modelId } = this.resolveLlmProvider(character, settings, overrides);

    onEvent({ type: 'status', message: 'Escribiendo el prompt de la escena…' });
    const llmPrompt = this.buildSceneImagePromptText(character, scenePrompt, settings);

    const llm = createProvider(provider);
    const llmResponse = await llm.generate({
      messages: [{ role: 'user', content: llmPrompt }],
      model: modelId,
      temperature: 0.7,
      stream: false,
    });
    const finalImagePrompt = llmResponse.content.trim();

    onEvent({ type: 'status', message: 'Generando imagen…' });

    const imageProvider = createImageProvider(settings);
    let buffer: Buffer, filename: string;

    const avatarDiskPath = character.avatar
      ? path.join(PROJECT_ROOT, 'data', 'images', character.avatar.replace(/^\/images\//, ''))
      : null;
    const onProgress = (evt: ImageProgressEvent) => onEvent(evt);

    if (imageProvider.supportsReference && avatarDiskPath && fs.existsSync(avatarDiskPath)) {
      ({ buffer, filename } = await imageProvider.generateWithReference!({
        prompt: finalImagePrompt,
        referenceImagePath: avatarDiskPath,
        ...(overrides?.workflowName ? { workflowName: overrides.workflowName } : {}),
      }, onProgress));
    } else if (imageProvider.generateWithProgress) {
      ({ buffer, filename } = await imageProvider.generateWithProgress({
        prompt: finalImagePrompt,
        workflowName: overrides?.workflowName ?? 'image_z_image_turbo',
      }, onProgress));
    } else {
      ({ buffer, filename } = await imageProvider.generate({
        prompt: finalImagePrompt,
        workflowName: overrides?.workflowName ?? 'image_z_image_turbo',
      }));
    }

    const base64 = buffer.toString('base64');
    const updated = this.addImage(id, base64, filename, false);
    return { character: updated, generatedPrompt: finalImagePrompt };
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
