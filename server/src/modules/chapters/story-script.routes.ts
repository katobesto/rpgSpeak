import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { StoryScriptRepository } from './story-script.repository.js';
import { ChapterRepository } from './chapter.repository.js';
import { StoryRepository } from '../stories/story.repository.js';
import { CharacterRepository } from '../characters/character.repository.js';
import { ProviderRepository } from '../providers/provider.repository.js';
import { SettingsService } from '../settings/settings.service.js';
import { createProvider } from '../../core/llm/provider.factory.js';
import { ValidationError } from '../../shared/errors.js';

const scriptRepo = new StoryScriptRepository();
const chapterRepo = new ChapterRepository();
const storyRepo   = new StoryRepository();
const charRepo    = new CharacterRepository();
const provRepo    = new ProviderRepository();
const settings    = new SettingsService();

const CHAPTER_RE = /\[CAPITULO:(\d+)\|([^\]|]+)\|([^\]]+)\]/g;

function parseChapters(text: string) {
  const chapters: { number: number; title: string; description: string }[] = [];
  for (const m of text.matchAll(CHAPTER_RE)) {
    const num = parseInt(m[1], 10);
    const title = m[2].trim();
    const desc  = m[3].trim();
    if (num >= 1 && num <= 20 && title) chapters.push({ number: num, title, description: desc });
  }
  return chapters.sort((a, b) => a.number - b.number);
}

export const storyScriptRoutes: FastifyPluginAsync = async (app) => {

  // GET /api/story-script/:storyId — obtener guión de una historia
  app.get<{ Params: { storyId: string } }>('/:storyId', async (req) => {
    const chapters = scriptRepo.findByStory(req.params.storyId);
    return { success: true, data: chapters };
  });

  // POST /api/story-script/generate — generar guión para una historia
  app.post('/generate', async (req, reply) => {
    const schema = z.object({
      storyId:    z.string(),
      regenerate: z.boolean().optional().default(false),
    });
    const { storyId, regenerate } = schema.parse(req.body);

    if (!regenerate && scriptRepo.hasScript(storyId)) {
      return reply.send({ success: true, data: scriptRepo.findByStory(storyId) });
    }

    const story = storyRepo.findById(storyId);
    if (!story) throw new ValidationError('Historia no encontrada');

    // Contexto de la historia
    const storyContext = [
      story.name,
      story.description,
      story.globalContext && `Contexto: ${story.globalContext}`,
      story.worldLore     && `Lore: ${story.worldLore}`,
      story.narrativeRules && `Reglas: ${story.narrativeRules}`,
    ].filter(Boolean).join('\n');

    // Personajes del guión (todos los vinculados)
    const chars = story.characters
      .map(c => charRepo.findById(c.characterId))
      .filter(Boolean)
      .map(c => `- ${c!.name}: ${c!.description || '(sin descripción)'}`)
      .join('\n') || '(sin personajes definidos)';

    const prompt = `Eres el diseñador narrativo de la siguiente campaña de rol. Basándote en la historia, el lore y los personajes, genera exactamente 10 capítulos que estructuren la aventura de principio a fin con una progresión dramática clara.

## Historia
${storyContext}

## Personajes
${chars}

REQUISITOS DE CADA CAPÍTULO:
- Título corto y evocador (máximo 5 palabras)
- Descripción de 2-4 frases escrita como DIRECTIVA DE ESCENA (lo que DEBE ocurrir, no lo que ocurrió):
  · Usa infinitivo o futuro: "El grupo debe llegar a...", "La escena abre con...", "El antagonista revela..."
  · UN evento o situación concreta y específica que debe suceder en pantalla, narrado paso a paso
  · AL MENOS UN PNJ o facción activa que impulsa los eventos
  · La condición de cierre: qué debe haber ocurrido para que el capítulo se considere concluido
  · IMPORTANTE: escribe los eventos en el orden en que deben NARRARSE, del primero al último

ESTRUCTURA DRAMÁTICA:
- Cap. 1-2: Introducción del conflicto y amenaza
- Cap. 3-4: Primera escalada, implicación de los personajes
- Cap. 5-6: Punto de giro — revelación que cambia el planteamiento
- Cap. 7-8: Crisis máxima, peligro real e inmediato
- Cap. 9: Preparación para el clímax, alianzas o traiciones
- Cap. 10: Clímax y resolución

EJEMPLO DE DESCRIPCIÓN CORRECTA:
"La escena abre con el coche averiándose en una carretera desierta bajo la lluvia. El grupo debe caminar hasta la aldea de Varen, donde buscarán refugio. La posada La Cabaña les acogerá, pero la anciana posadero les advierte de no salir tras el anochecer. El capítulo cierra cuando el grupo está instalado y ha oído la primera advertencia."

Responde ÚNICAMENTE con etiquetas, una por línea, sin texto adicional:
[CAPITULO:1|Título|Descripción específica]
...
[CAPITULO:10|Título|Descripción específica]`;

    const s = settings.getAll();
    if (!s.defaultProviderId) throw new ValidationError('No hay provider LLM configurado');
    const provider = provRepo.findById(s.defaultProviderId);
    if (!provider?.isEnabled) throw new ValidationError('El provider LLM no está disponible');

    const llm = createProvider(provider);
    const result = await llm.generate({
      messages:    [{ role: 'user', content: prompt }],
      model:       s.defaultModelId ?? '',
      stream:      false,
      temperature: 0.75,
      maxTokens:   2500,
    });

    const parsed = parseChapters(result.content);
    if (parsed.length === 0) throw new ValidationError('El LLM no generó capítulos válidos. Inténtalo de nuevo.');

    scriptRepo.createBatch(storyId, parsed);
    console.log(`[story-script] Generated ${parsed.length} chapters for story ${storyId}`);

    return reply.status(201).send({ success: true, data: scriptRepo.findByStory(storyId) });
  });

  // POST /api/story-script/copy-to-conversation — copiar guión al chat
  app.post('/copy-to-conversation', async (req) => {
    const schema = z.object({
      storyId:        z.string(),
      conversationId: z.string(),
    });
    const { storyId, conversationId } = schema.parse(req.body);

    if (chapterRepo.hasChapters(conversationId)) {
      return { success: true, data: chapterRepo.findByConversation(conversationId) };
    }

    const script = scriptRepo.findByStory(storyId);
    if (script.length > 0) {
      chapterRepo.copyFromScript(conversationId, script);
    }
    return { success: true, data: chapterRepo.findByConversation(conversationId) };
  });

  // DELETE /api/story-script/:storyId — borrar guión de historia
  app.delete<{ Params: { storyId: string } }>('/:storyId', async (_req, reply) => {
    scriptRepo.deleteByStory(_req.params.storyId);
    return reply.status(204).send();
  });
};
