import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { StoryService } from './story.service.js';
import { createStorySchema, updateStorySchema } from './story.schema.js';
import { ValidationError, ForbiddenError } from '../../shared/errors.js';
import { ProviderRepository } from '../providers/provider.repository.js';
import { SettingsService } from '../settings/settings.service.js';
import { createProvider } from '../../core/llm/provider.factory.js';
import type { StoryEvent, StoryLocation, StoryAssistantResult, StoryAssistantCharacterDraft } from '@rpgspeak/shared';

const service = new StoryService();

// ─── Parser for generated events ─────────────────────────────────────────────

// 5º campo (ubicación) opcional — retrocompatible con etiquetas de 4 campos.
const EVENT_TAG_RE = /\[EVENTO:([^\]|]+)\|([^\]|]+)\|([^\]|]+)\|(\d+)(?:\|([^\]|]*))?\]/g;

// ─── Parser for generated locations ──────────────────────────────────────────

// [OÓ] + flag i: el modelo suele emitir la tilde ([UBICACIÓN:...]) o minúsculas
// pese a la directiva; sin tolerarlo, la ubicación generada se descartaba en silencio.
const LOCATION_TAG_RE = /\[UBICACI[OÓ]N:([^\]|]+)\|([^\]|]*)\|([^\]|]*)\|([^\]|]*)\|([^\]]*)\]/gi;

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
    const location    = (m[5] ?? '').trim();
    if (!title) continue;
    events.push({ title, trigger, description, importance, location });
  }
  return events;
}

/** Refuerzo de formato añadido EN CÓDIGO tras la plantilla (que vive en BD y
 *  puede ser antigua): pide el 5º campo (ubicación) anclado a las ubicaciones
 *  definidas de la historia, para que el narrador pueda GUIAR al jugador hacia
 *  el lugar de cada evento. */
function eventLocationFormatAppendix(locations: StoryLocation[]): string {
  const names = locations.map((l) => l.name.trim()).filter(Boolean);
  const anchor = names.length > 0
    ? `Usa PREFERENTEMENTE una de las ubicaciones definidas de la historia: ${names.join(' · ')}. ` +
      `Solo si ningún lugar definido encaja, describe brevemente uno nuevo coherente con el mundo.`
    : `Describe brevemente el lugar (aún no hay ubicaciones definidas en la historia).`;
  return (
    `\n\nFORMATO OBLIGATORIO DE LAS ETIQUETAS DE EVENTO — 5 campos:\n` +
    `[EVENTO:título|disparador|descripción|importancia|ubicación donde ocurre]\n` +
    `El 5º campo (ubicación) es OBLIGATORIO: indica DÓNDE ocurre el evento, para que el narrador pueda ` +
    `conducir la historia hacia ese lugar. ${anchor}\n` +
    `Reparte los eventos entre DISTINTAS ubicaciones cuando tenga sentido: eso crea un recorrido por el mundo, ` +
    `no una sucesión de escenas en el mismo sitio.`
  );
}

// ─── Story-assistant helpers ─────────────────────────────────────────────────

/** Maps the 1-5 pacing slider to a directive that is woven into the prompt and the
 *  generated story's narrative rules so it carries through to actual play. */
function pacingDirective(pacing: number): string {
  switch (Math.min(5, Math.max(1, Math.round(pacing)))) {
    case 1:
      return 'Muy pausado y contemplativo. Prioriza la introspección, el detalle sensorial, las conversaciones largas y el desarrollo emocional. Los acontecimientos importantes son escasos y se construyen con lentitud; deja respirar las escenas.';
    case 2:
      return 'Pausado. Da espacio a la atmósfera y a los personajes; los giros importantes llegan poco a poco, sin prisa.';
    case 3:
      return 'Equilibrado. Alterna momentos tranquilos de desarrollo con escenas de acción o tensión.';
    case 4:
      return 'Ágil. Suceden cosas con frecuencia: mantén la tensión alta y sorprende al jugador a menudo con giros y complicaciones.';
    default:
      return 'Muy rápido y frenético. Constantemente ocurren acontecimientos sorprendentes, giros inesperados y peligros. Cada escena introduce algo nuevo; nunca hay tiempos muertos.';
  }
}

/** Extracts ordered "LABEL: value" fields from a block. Each value runs until the
 *  next known label or the end of the block, so multi-line values are preserved. */
function extractBlockFields(block: string, labels: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  const labelAlt = labels.join('|');
  for (const label of labels) {
    const re = new RegExp(
      `(?:^|\\n)\\s*${label}\\s*:\\s*([\\s\\S]*?)(?=\\n\\s*(?:${labelAlt})\\s*:|$)`,
      'i',
    );
    const m = block.match(re);
    result[label.toLowerCase()] = m ? m[1].trim() : '';
  }
  return result;
}

const HISTORIA_BLOCK_RE  = /===HISTORIA===([\s\S]*?)===FIN HISTORIA===/i;
const PERSONAJE_BLOCK_RE = /===PERSONAJE===([\s\S]*?)===FIN PERSONAJE===/gi;

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
      .replace('{{CONTEXTO_HISTORIA}}', storyContext)
      + eventLocationFormatAppendix(story.locations ?? []);

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

  // POST /stories/assistant — generate a full story + characters draft from a briefing.
  // Does NOT write to the DB: returns drafts so the client can preview and confirm.
  app.post('/assistant', async (req, reply) => {
    const hintSchema = z.object({
      name:  z.string().max(100).default(''),
      notes: z.string().max(1000).default(''),
    });
    const schema = z.object({
      theme:          z.string().min(1, 'Indica una temática o premisa').max(2000),
      genre:          z.string().max(200).default(''),
      tone:           z.string().max(200).default(''),
      pacing:         z.number().int().min(1).max(5).default(3),
      numCharacters:  z.number().int().min(1).max(8).default(3),
      numEvents:      z.number().int().min(0).max(15).default(5),
      numLocations:   z.number().int().min(0).max(15).default(4),
      adventureMode:  z.boolean().default(false),
      openWorld:      z.boolean().default(false),
      characterHints: z.array(hintSchema).max(8).default([]),
      extra:          z.string().max(2000).default(''),
    });
    const briefing = schema.parse(req.body);

    const settings = new SettingsService();
    const provRepo = new ProviderRepository();

    const providerId = settings.get('defaultProviderId') as string | null;
    const modelId    = settings.get('defaultModelId')    as string | null;
    if (!providerId) throw new ValidationError('No hay ningún provider LLM configurado');

    const providerRecord = provRepo.findById(providerId);
    if (!providerRecord?.isEnabled) throw new ValidationError('El provider LLM no está disponible');

    const llm = createProvider(providerRecord);

    const pacingText = `${briefing.pacing}/5 — ${pacingDirective(briefing.pacing)}`;
    const hintsText = briefing.characterHints.length
      ? briefing.characterHints
          .map((h, i) => `  ${i + 1}. ${h.name?.trim() || '(nombre libre)'}${h.notes?.trim() ? ` — ${h.notes.trim()}` : ''}`)
          .join('\n')
      : '  (ninguno: invéntalos todos)';

    const promptTemplate = settings.get('storyAssistantPrompt') as string;
    const prompt = promptTemplate
      .replace('{{TEMATICA}}',             briefing.theme.trim())
      .replace('{{GENERO}}',               briefing.genre.trim()  || '(libre)')
      .replace('{{TONO}}',                 briefing.tone.trim()   || '(libre)')
      .replace('{{RITMO}}',                pacingText)
      .replace('{{MODO_AVENTURA}}',        briefing.adventureMode ? 'Sí' : 'No')
      .replace('{{MUNDO_ABIERTO}}',        briefing.openWorld ? 'Sí' : 'No')
      .replace(/\{\{NUM_PERSONAJES\}\}/g,  String(briefing.numCharacters))
      .replace(/\{\{NUM_EVENTOS\}\}/g,     String(briefing.numEvents))
      .replace(/\{\{NUM_UBICACIONES\}\}/g, String(briefing.numLocations))
      .replace('{{PERSONAJES_SUGERIDOS}}', hintsText)
      .replace('{{EXTRA}}',                briefing.extra.trim() || '(ninguna)')
      // El asistente genera eventos Y ubicaciones a la vez: los eventos deben
      // anclarse a las ubicaciones que él mismo crea (mismos nombres).
      + `\n\nFORMATO OBLIGATORIO DE LOS EVENTOS — 5 campos:\n` +
      `[EVENTO:título|disparador|descripción|importancia|ubicación donde ocurre]\n` +
      `El 5º campo (ubicación) es OBLIGATORIO y debe coincidir con el NOMBRE de una de las ubicaciones que ` +
      `generes en este mismo diseño — así el narrador podrá conducir al jugador hacia el lugar de cada evento. ` +
      `Reparte los eventos entre distintas ubicaciones para que la historia recorra el mundo.`;

    const llmResult = await llm.generate({
      messages: [
        {
          role: 'system',
          content: 'Eres un diseñador de campañas de rol. Sigue el formato de salida EXACTAMENTE, sin texto adicional fuera de los bloques y etiquetas indicados.',
        },
        { role: 'user', content: prompt },
      ],
      model:       modelId ?? '',
      temperature: 0.85,
      maxTokens:   6000,
      stream:      false,
    });

    const text = llmResult.content;

    // Parse story block
    const histMatch = text.match(HISTORIA_BLOCK_RE);
    const histFields = histMatch
      ? extractBlockFields(histMatch[1], ['NOMBRE', 'DESCRIPCION', 'CONTEXTO', 'LORE', 'REGLAS'])
      : {};

    // Weave the pacing directive into the narrative rules so it persists into play.
    const baseRules = (histFields.reglas ?? '').trim();
    const narrativeRules = [
      baseRules,
      `## Ritmo de la narración (${briefing.pacing}/5)\n${pacingDirective(briefing.pacing)}`,
    ].filter(Boolean).join('\n\n');

    // Parse character blocks
    const characters: StoryAssistantCharacterDraft[] = [];
    for (const m of text.matchAll(PERSONAJE_BLOCK_RE)) {
      const f = extractBlockFields(m[1], ['NOMBRE', 'ROL', 'DESCRIPCION', 'PERSONALIDAD', 'LORE', 'TAGS']);
      if (!f.nombre) continue;
      characters.push({
        name:        f.nombre,
        role:        f.rol ?? '',
        description: f.descripcion ?? '',
        personality: f.personalidad ?? '',
        lore:        f.lore ?? '',
        tags: (f.tags ?? '')
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean)
          .slice(0, 8),
      });
    }

    const result: StoryAssistantResult = {
      story: {
        name:           histFields.nombre?.trim() || briefing.theme.slice(0, 60),
        description:    histFields.descripcion ?? '',
        globalContext:  histFields.contexto ?? '',
        worldLore:      histFields.lore ?? '',
        narrativeRules,
        events:    parseGeneratedEvents(text),
        locations: parseGeneratedLocations(text),
      },
      characters,
    };

    console.log(
      `[story/assistant] Generated story "${result.story.name}" with ${characters.length} characters, ` +
      `${result.story.events.length} events, ${result.story.locations.length} locations`,
    );

    if (!histMatch && characters.length === 0) {
      throw new ValidationError('El LLM no devolvió un resultado en el formato esperado. Inténtalo de nuevo.');
    }

    return reply.send({ success: true, data: result });
  });
};
