import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { SummariesRepository } from './summaries.repository.js';
import { ConversationRepository } from '../conversations/conversation.repository.js';
import { MessageRepository } from '../messages/message.repository.js';
import { ProviderRepository } from '../providers/provider.repository.js';
import { CharacterRepository } from '../characters/character.repository.js';
import { SettingsService } from '../settings/settings.service.js';
import { createProvider } from '../../core/llm/provider.factory.js';
import { ValidationError, NotFoundError } from '../../shared/errors.js';
import type { GenerateRequest } from '@rpgspeak/shared';

const repo     = new SummariesRepository();
const convRepo = new ConversationRepository();
const msgRepo  = new MessageRepository();
const provRepo = new ProviderRepository();
const charRepo = new CharacterRepository();
const settings = new SettingsService();

export const summariesRoutes: FastifyPluginAsync = async (app) => {

  // GET /api/summaries?conversationId=X — lista de resúmenes de la conversación
  app.get<{ Querystring: { conversationId?: string } }>('/', async (req, reply) => {
    const { conversationId } = req.query;
    if (!conversationId) throw new ValidationError('conversationId es requerido');
    const items = repo.findByConversation(conversationId);
    return reply.send({ success: true, data: items });
  });

  // POST /api/summaries/generate — genera un nuevo resumen para un rango de mensajes
  app.post('/generate', async (req, reply) => {
    const schema = z.object({
      conversationId:   z.string(),
      messageIndexFrom: z.number().int().min(0),
      messageIndexTo:   z.number().int().min(0),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0].message);

    const { conversationId, messageIndexFrom, messageIndexTo } = parsed.data;

    // Verificar que la conversación existe
    const conv = convRepo.findById(conversationId);
    if (!conv) throw new NotFoundError('Conversation', conversationId);

    // Obtener mensajes en el rango indicado
    const allMessages = msgRepo.findByConversation(conversationId);
    const rangeMessages = allMessages.slice(messageIndexFrom, messageIndexTo + 1)
      .filter((m) => m.role !== 'system');

    if (rangeMessages.length < 1) {
      throw new ValidationError('No hay mensajes en el rango indicado');
    }

    // Detectar si hay narrador (sin personaje específico)
    const isNarrator = conv.mode === 'story' && !conv.activeCharacterId;

    // Resolver el proveedor LLM a usar
    const s = settings.getAll();
    const firstCharId = conv.characters[0]?.characterId;
    const firstChar   = firstCharId ? charRepo.findById(firstCharId) : null;
    const providerId  = firstChar?.providerId ?? s.defaultProviderId ?? 'default-ollama';
    const provider    = provRepo.findById(providerId);

    if (!provider || !provider.isEnabled) {
      throw new ValidationError('No hay proveedor LLM disponible para generar el resumen');
    }

    const modelId = firstChar?.modelId ?? provider.defaultModel ?? s.defaultModelId;
    if (!modelId) {
      throw new ValidationError('No hay modelo LLM configurado');
    }

    const maxFrases = s.summaryMaxLength ?? 5;

    const messagesText = rangeMessages
      .map((m) => `${m.role === 'user' ? 'Jugador' : (isNarrator ? 'Narrador' : 'Personaje')}: ${m.content}`)
      .join('\n\n');

    const prompt = `Eres el asistente de una historia colaborativa de rol. A continuación tienes un fragmento de la historia (mensajes ${messageIndexFrom + 1}–${messageIndexTo + 1}):

---
${messagesText}
---

Escribe un resumen de lo ocurrido en este fragmento. El resumen debe ser:
- Objetivo y fiel a lo narrado
- Conciso: máximo ${maxFrases} frases
- En pasado narrativo (tercera persona o segunda persona según el estilo)
- Sin explicaciones, meta-comentarios ni frases introductorias

Responde SOLO con el texto del resumen.`;

    const llm = createProvider(provider);
    const request: GenerateRequest = {
      messages: [
        { role: 'system', content: 'Eres un asistente que resume fragmentos de historias colaborativas de rol.' },
        { role: 'user',   content: prompt },
      ],
      model:            modelId,
      temperature:      0.3,
      stream:           false,
      disableFallbacks: s.disableFallbacks,
    };

    const response = await llm.generate(request);
    const summaryContent = response.content.trim();

    if (!summaryContent) {
      throw new ValidationError('El modelo no generó contenido');
    }

    // Guardar en la tabla de resúmenes
    const newSummary = repo.create({
      conversationId,
      content:          summaryContent,
      messageIndexFrom,
      messageIndexTo,
    });

    // Actualizar también el campo conversations.summary para compatibilidad con el context-builder
    convRepo.update(conversationId, { summary: summaryContent });

    app.log.info(`[summaries] Nuevo resumen generado para conv ${conversationId} (msgs ${messageIndexFrom}–${messageIndexTo})`);

    return reply.status(201).send({ success: true, data: newSummary });
  });

  // DELETE /api/summaries/:id — eliminar un resumen
  app.delete<{ Params: { id: string } }>('/:id', async (req, reply) => {
    repo.delete(req.params.id);
    return reply.status(204).send();
  });
};
