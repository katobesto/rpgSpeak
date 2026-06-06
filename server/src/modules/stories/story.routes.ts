import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { StoryService } from './story.service.js';
import { createStorySchema, updateStorySchema } from './story.schema.js';
import { ValidationError, ForbiddenError } from '../../shared/errors.js';
import { ProviderRepository } from '../providers/provider.repository.js';
import { SettingsService } from '../settings/settings.service.js';
import { createProvider } from '../../core/llm/provider.factory.js';
import type { StoryEvent, StoryLocation } from '@rpgspeak/shared';

const service = new StoryService();

// ─── Parser for generated events ─────────────────────────────────────────────

const EVENT_TAG_RE = /\[EVENTO:([^\]|]+)\|([^\]|]+)\|([^\]|]+)\|(\d+)\]/g;

// ─── Parser for generated locations ──────────────────────────────────────────

const LOCATION_TAG_RE = /\[UBICACION:([^\]|]+)\|([^\]|]*)\|([^\]|]*)\|([^\]|]*)\|([^\]]*)\]/g;

function parseGeneratedLocations(text: string): Omit<StoryLocation, 'id'>[] {
  const locations: Omit<StoryLocation, 'id'>[] = [];
  for (const m of text.matchAll(LOCATION_TAG_RE)) {
    const name        = m[1].trim();
    const description = m[2].trim();
    const contents    = m[3].trim();
    const exits       = m[4].trim();
    const atmosphere  = m[5].trim();
    if (!name) continue;
    locations.push({ name, description, contents, exits, atmosphere });
  }
  return locations;
}

function parseGeneratedEvents(text: string): Omit<StoryEvent, 'id' | 'timestamp'>[] {
  const events: Omit<StoryEvent, 'id' | 'timestamp'>[] = [];
  for (const m of text.matchAll(EVENT_TAG_RE)) {
    const title       = m[1].trim();
    const trigger     = m[2].trim();
    const description = m[3].trim();
    const importance  = Math.min(10, Math.max(1, parseInt(m[4], 10)));
    if (!title) continue;
    events.push({ title, trigger, description, importance });
  }
  return events;
}

export const storyRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', async (req) => {
    const { search, text, characterId, filterUserId } =
      req.query as { search?: string; text?: string; characterId?: string; filterUserId?: string };
    const { userId, role } = (req as any).authUser ?? {};
    const isAdmin = role === 'admin';
    return {
      success: true,
      data: service.list({
        search,
        text,
        userId,
        isAdmin,
        characterId,
        filterUserId: isAdmin ? filterUserId : undefined, // solo admins
      }),
    };
  });

  app.get<{ Params: { id: string } }>('/:id', async (req) => {
    return { success: true, data: service.get(req.params.id) };
  });

  app.post('/', async (req, reply) => {
    const result = createStorySchema.safeParse(req.body);
    if (!result.success) throw new ValidationError(result.error.issues[0].message);
    const { userId } = (req as any).authUser ?? {};
    return reply.status(201).send({ success: true, data: service.create(result.data, userId) });
  });

  app.patch<{ Params: { id: string } }>('/:id', async (req) => {
    const result = updateStorySchema.safeParse(req.body);
    if (!result.success) throw new ValidationError(result.error.issues[0].message);
    const { userId, role } = (req as any).authUser ?? {};
    const existing = service.get(req.params.id);
    if (existing.userId !== userId && role !== 'admin') {
      throw new ForbiddenError('No tienes permiso para editar esta historia');
    }
    return { success: true, data: service.update(req.params.id, result.data) };
  });

  app.delete<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const { userId, role } = (req as any).authUser ?? {};
    const existing = service.get(req.params.id);
    if (existing.userId !== userId && role !== 'admin') {
      throw new ForbiddenError('No tienes permiso para eliminar esta historia');
    }
    service.delete(req.params.id);
    return reply.status(204).send();
  });

  // POST /stories/generate-events — generate story events with the main LLM
  app.post('/generate-events', async (req, reply) => {
    const schema = z.object({
      storyId:   z.string(),
      numEvents: z.number().int().min(1).max(20).default(5),
    });
    const { storyId, numEvents } = schema.parse(req.body);

    const story = service.get(storyId); // throws NotFoundError if missing

    const settings  = new SettingsService();
    const provRepo  = new ProviderRepository();

    // Use default LLM provider
    const providerId = settings.get('defaultProviderId') as string | null;
    const modelId    = settings.get('defaultModelId')    as string | null;
    if (!providerId) throw new ValidationError('No hay ningún provider LLM configurado');

    const providerRecord = provRepo.findById(providerId);
    if (!providerRecord?.isEnabled) throw new ValidationError('El provider LLM no está disponible');

    const llm = createProvider(providerRecord);

    // Build story context from available fields
    const contextParts: string[] = [];
    if (story.globalContext?.trim())  contextParts.push(`## Contexto global\n${story.globalContext.trim()}`);
    if (story.worldLore?.trim())      contextParts.push(`## Lore del mundo\n${story.worldLore.trim()}`);
    if (story.narrativeRules?.trim()) contextParts.push(`## Reglas narrativas\n${story.narrativeRules.trim()}`);
    if (story.description?.trim())    contextParts.push(`## Descripción de la historia\n${story.description.trim()}`);
    const storyContext = contextParts.length > 0
      ? contextParts.join('\n\n')
      : `Historia: ${story.name}`;

    const promptTemplate = settings.get('storyEventGenerationPrompt') as string;
    const prompt = promptTemplate
      .replace('{{NUM_EVENTOS}}',      String(numEvents))
      .replace('{{CONTEXTO_HISTORIA}}', storyContext);

    const llmResult = await llm.generate({
      messages: [
        {
          role: 'system',
          content: 'Eres un diseñador narrativo de juegos de rol. Responde SOLO con las etiquetas [EVENTO:...] indicadas, sin texto adicional.',
        },
        { role: 'user', content: prompt },
      ],
      model:       modelId ?? '',
      temperature: 0.7,
      maxTokens:   2000,
      stream:      false,
    });

    const parsed = parseGeneratedEvents(llmResult.content);
    const now    = new Date().toISOString();
    const events: StoryEvent[] = parsed.map((e) => ({
      id:          crypto.randomUUID(),
      timestamp:   now,
      ...e,
    }));

    console.log(`[story/generate-events] Generated ${events.length}/${numEvents} events for story "${story.name}"`);
    return reply.send({ success: true, data: { events } });
  });

  // POST /stories/generate-locations — generate story locations with the main LLM
  app.post('/generate-locations', async (req, reply) => {
    const schema = z.object({
      storyId:      z.string(),
      numLocations: z.number().int().min(1).max(20).default(5),
    });
    const { storyId, numLocations } = schema.parse(req.body);

    const story = service.get(storyId);

    const settings  = new SettingsService();
    const provRepo  = new ProviderRepository();

    const providerId = settings.get('defaultProviderId') as string | null;
    const modelId    = settings.get('defaultModelId')    as string | null;
    if (!providerId) throw new ValidationError('No hay ningún provider LLM configurado');

    const providerRecord = provRepo.findById(providerId);
    if (!providerRecord?.isEnabled) throw new ValidationError('El provider LLM no está disponible');

    const llm = createProvider(providerRecord);

    const contextParts: string[] = [];
    if (story.globalContext?.trim())  contextParts.push(`## Contexto global\n${story.globalContext.trim()}`);
    if (story.worldLore?.trim())      contextParts.push(`## Lore del mundo\n${story.worldLore.trim()}`);
    if (story.narrativeRules?.trim()) contextParts.push(`## Reglas narrativas\n${story.narrativeRules.trim()}`);
    if (story.description?.trim())    contextParts.push(`## Descripción de la historia\n${story.description.trim()}`);
    const storyContext = contextParts.length > 0
      ? contextParts.join('\n\n')
      : `Historia: ${story.name}`;

    const promptTemplate = settings.get('storyLocationGenerationPrompt') as string;
    const prompt = promptTemplate
      .replace('{{NUM_UBICACIONES}}',   String(numLocations))
      .replace('{{CONTEXTO_HISTORIA}}', storyContext);

    const llmResult = await llm.generate({
      messages: [
        {
          role: 'system',
          content: 'Eres un diseñador de mundos para juegos de rol. Responde SOLO con las etiquetas [UBICACION:...] indicadas, sin texto adicional.',
        },
        { role: 'user', content: prompt },
      ],
      model:       modelId ?? '',
      temperature: 0.7,
      maxTokens:   3000,
      stream:      false,
    });

    const parsed = parseGeneratedLocations(llmResult.content);
    const locations: StoryLocation[] = parsed.map((loc) => ({
      id: crypto.randomUUID(),
      ...loc,
    }));

    console.log(`[story/generate-locations] Generated ${locations.length}/${numLocations} locations for story "${story.name}"`);
    return reply.send({ success: true, data: { locations } });
  });
};
