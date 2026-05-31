import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { ChapterRepository } from './chapter.repository.js';
import { ConversationRepository } from '../conversations/conversation.repository.js';
import { StoryRepository } from '../stories/story.repository.js';
import { CharacterRepository } from '../characters/character.repository.js';
import { ProviderRepository } from '../providers/provider.repository.js';
import { SettingsService } from '../settings/settings.service.js';
import { createProvider } from '../../core/llm/provider.factory.js';
import { ValidationError } from '../../shared/errors.js';

const chapterRepo  = new ChapterRepository();
const convRepo     = new ConversationRepository();
const storyRepo    = new StoryRepository();
const charRepo     = new CharacterRepository();
const provRepo     = new ProviderRepository();
const settings     = new SettingsService();

// ─── Regex para parsear capítulos generados por el LLM ───────────────────────
const CHAPTER_RE = /\[CAPITULO:(\d+)\|([^\]|]+)\|([^\]]+)\]/g;

function parseChapters(text: string): { number: number; title: string; description: string }[] {
  const chapters: { number: number; title: string; description: string }[] = [];
  for (const m of text.matchAll(CHAPTER_RE)) {
    const num   = parseInt(m[1], 10);
    const title = m[2].trim();
    const desc  = m[3].trim();
    if (num >= 1 && num <= 20 && title) {
      chapters.push({ number: num, title, description: desc });
    }
  }
  return chapters.sort((a, b) => a.number - b.number);
}

export const chapterRoutes: FastifyPluginAsync = async (app) => {

  // GET /api/chapters/:conversationId — lista de capítulos
  app.get<{ Params: { conversationId: string } }>('/:conversationId', async (req) => {
    const chapters = chapterRepo.findByConversation(req.params.conversationId);
    return { success: true, data: chapters };
  });

  // POST /api/chapters/generate — genera los capítulos para una conversación
  app.post('/generate', async (req, reply) => {
    const schema = z.object({ conversationId: z.string() });
    const { conversationId } = schema.parse(req.body);

    // Verificar que no existen ya
    if (chapterRepo.hasChapters(conversationId)) {
      return reply.send({ success: true, data: chapterRepo.findByConversation(conversationId) });
    }

    const conv = convRepo.findById(conversationId);
    if (!conv) throw new ValidationError('Conversación no encontrada');

    // Reunir historias vinculadas
    const linkedStories = conv.stories
      .map((s) => storyRepo.findById(s.storyId))
      .filter(Boolean);

    if (linkedStories.length === 0) {
      throw new ValidationError('Esta conversación no tiene historias vinculadas');
    }

    // Reunir personajes vinculados
    const linkedChars = conv.characters
      .map((c) => charRepo.findById(c.characterId))
      .filter(Boolean);

    // Construir contexto de la historia
    const storyContext = linkedStories.map((s) => {
      const parts: string[] = [`## ${s!.name}`];
      if (s!.description)    parts.push(s!.description);
      if (s!.globalContext)  parts.push(`Contexto: ${s!.globalContext}`);
      if (s!.worldLore)      parts.push(`Lore: ${s!.worldLore}`);
      if (s!.narrativeRules) parts.push(`Reglas narrativas: ${s!.narrativeRules}`);
      return parts.join('\n');
    }).join('\n\n');

    const charsContext = linkedChars.length > 0
      ? linkedChars.map((c) => `- ${c!.name}: ${c!.description || '(sin descripción)'}`).join('\n')
      : '(sin personajes definidos)';

    const prompt = `Eres el diseñador narrativo de la siguiente campaña de rol. Basándote en la historia, el lore y los personajes activos, genera exactamente 10 capítulos que estructuren la aventura de principio a fin con una progresión dramática clara.

## Historia
${storyContext}

## Personajes activos
${charsContext}

REQUISITOS DE CADA CAPÍTULO:
- Título corto y evocador (máximo 5 palabras)
- Descripción de 2-4 frases que incluya:
  · UN evento o situación concreta que ocurre en este capítulo (no vaga, sino específica)
  · AL MENOS UN PNJ o facción activa que impulsa los eventos (antagonista, aliado, neutro)
  · La condición implícita de cierre: qué debe haber pasado para que el capítulo esté completo
- La descripción debe ser suficientemente específica para que el narrador sepa QUÉ hacer, no solo el tono general

ESTRUCTURA DRAMÁTICA ESPERADA:
- Cap. 1-2: Introducción del conflicto, presentación del mundo y amenaza
- Cap. 3-4: Primera escalada, los personajes se implican, primeras pérdidas o victorias
- Cap. 5-6: Punto de giro — revelación o complicación que cambia el planteamiento inicial
- Cap. 7-8: Crisis máxima, los recursos se agotan, el peligro es real e inmediato
- Cap. 9: Preparación para el enfrentamiento final, alianzas o traiciones
- Cap. 10: Clímax y resolución

Responde ÚNICAMENTE con las etiquetas siguientes, una por línea, sin texto adicional:
[CAPITULO:1|Título del capítulo 1|Descripción específica del capítulo 1]
[CAPITULO:2|Título del capítulo 2|Descripción específica del capítulo 2]
...
[CAPITULO:10|Título del capítulo 10|Descripción específica del capítulo 10]`;

    const s          = settings.getAll();
    const providerId = s.defaultProviderId;
    const modelId    = s.defaultModelId;

    if (!providerId) throw new ValidationError('No hay provider LLM configurado');

    const provider = provRepo.findById(providerId);
    if (!provider?.isEnabled) throw new ValidationError('El provider LLM no está disponible');

    const llm = createProvider(provider);
    const result = await llm.generate({
      messages: [{ role: 'user', content: prompt }],
      model:    modelId ?? '',
      stream:   false,
      temperature: 0.7,
      maxTokens:   2000,
    });

    const parsed = parseChapters(result.content);
    if (parsed.length === 0) {
      throw new ValidationError('El LLM no generó capítulos válidos. Inténtalo de nuevo.');
    }

    chapterRepo.createBatch(conversationId, parsed);
    console.log(`[chapters] Generated ${parsed.length} chapters for conv ${conversationId}`);

    return reply.status(201).send({
      success: true,
      data: chapterRepo.findByConversation(conversationId),
    });
  });

  // POST /api/chapters/:id/complete — marcar completado manualmente
  app.post<{ Params: { id: string } }>('/:id/complete', async (req) => {
    const schema = z.object({ conversationId: z.string() });
    const { conversationId } = schema.parse(req.body);
    const result = chapterRepo.completeCurrentChapter(conversationId);
    return { success: true, data: result };
  });

  // PATCH /api/chapters/:id — marcar completado / pendiente / activo
  app.patch<{ Params: { id: string } }>('/:id', async (req) => {
    const schema = z.object({
      action: z.enum(['complete', 'uncomplete', 'activate']),
    });
    const { action } = schema.parse(req.body);

    if (action === 'activate') {
      chapterRepo.setActive(req.params.id);
    } else {
      chapterRepo.setCompleted(req.params.id, action === 'complete');
    }

    return { success: true };
  });

  // DELETE /api/chapters/:conversationId — eliminar todos los capítulos
  app.delete<{ Params: { conversationId: string } }>('/:conversationId', async (_req, reply) => {
    chapterRepo.deleteByConversation(_req.params.conversationId);
    return reply.status(204).send();
  });
};
