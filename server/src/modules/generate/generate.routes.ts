import type { FastifyPluginAsync } from 'fastify';
import type { MemoryEntry, BackgroundImage, ConversationBackground } from '@rpgspeak/shared';
import { matchCharacterName } from '@rpgspeak/shared';
import { generateStream } from '../../core/conversation/engine.js';
import { ValidationError, NotFoundError } from '../../shared/errors.js';
import { z } from 'zod';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { ConversationRepository } from '../conversations/conversation.repository.js';
import { MessageRepository } from '../messages/message.repository.js';
import { CharacterRepository } from '../characters/character.repository.js';
import { StoryRepository } from '../stories/story.repository.js';
import { ProviderRepository } from '../providers/provider.repository.js';
import { SettingsService } from '../settings/settings.service.js';
import { createProvider } from '../../core/llm/provider.factory.js';
import { createImageProvider } from '../../core/image/image-provider.factory.js';
import { DYNAMISM_BLOCK } from '../../core/image/dynamism-block.js';
import { getUserById } from '../auth/auth.service.js';
import { MemoryRepository } from '../../core/memory/memory.repository.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../');

// ── Scene image helpers ───────────────────────────────────────────────────────

interface SceneImage { url: string; pending?: boolean; token?: string; description?: string }

/** Read sceneImages from metadata, falling back to the legacy sceneImageUrl field. */
function getSceneImages(meta: Record<string, unknown>): SceneImage[] {
  if (Array.isArray(meta.sceneImages)) return meta.sceneImages as SceneImage[];
  if (meta.sceneImageUrl) return [{ url: meta.sceneImageUrl as string, description: meta.sceneDescription as string | undefined }];
  return [];
}

const generateSchema = z.object({
  conversationId: z.string(),
  message: z.string().min(1).max(32768),
  characterId: z.string().optional(),
  branchId: z.string().optional(),
  narratorMode: z.boolean().default(false),
  overrides: z.object({
    providerId: z.string().optional(),
    temperature: z.number().min(0).max(2).optional(),
    maxTokens: z.number().int().positive().optional(),
    model: z.string().optional(),
  }).optional(),
});

/** Personaje del contexto (PNJ) — no pertenece al roster de la conversación.
 *  Detectado por el cliente (índice de contexto o diálogo del narrador) y
 *  seleccionado explícitamente por el usuario en el modal de escena. */
export interface ExtraSceneCharacter {
  name: string;
  description?: string;
}

// ── Shared helper: build the prompt text that gets sent to the LLM ──────────
async function buildScenePromptText(
  conversationId: string,
  messageId: string,
  userId?: string,
  selectedCharacterIds?: string[], // undefined = include all conversation characters
  includeUser?: boolean,           // undefined = include user if they have appearance
  messageCount: number = 6,        // how many recent messages to include as context
  extraCharacters?: ExtraSceneCharacter[], // PNJs del contexto seleccionados en el modal
): Promise<string> {
  const convRepo = new ConversationRepository();
  const msgRepo  = new MessageRepository();
  const charRepo = new CharacterRepository();
  const settings = new SettingsService();

  const conversation = convRepo.findById(conversationId);
  if (!conversation) throw new NotFoundError('Conversation', conversationId);

  const message = msgRepo.findById(messageId);
  if (!message) throw new NotFoundError('Message', messageId);

  const charLinks = conversation.characters;
  let characters = charLinks
    .map((l: { characterId: string }) => charRepo.findById(l.characterId))
    .filter(Boolean) as NonNullable<ReturnType<typeof charRepo.findById>>[];

  // Filter to only selected characters when an explicit list is provided
  if (selectedCharacterIds !== undefined) {
    characters = characters.filter((c) => selectedCharacterIds.includes(c!.id));
  }

  const charBlocks = characters
    .filter((c) => c !== null)
    .map((c) => {
      const lines = [`Name: ${c!.name}`];
      if (c!.description)      lines.push(`Description: ${c!.description}`);
      if (c!.imageDescription) lines.push(`Appearance: ${c!.imageDescription}`);
      return lines.join('\n');
    });

  // Include the current user's appearance so they can appear in the scene
  // includeUser=undefined → include only if user has appearance; explicit bool overrides
  if (userId) {
    const user = getUserById(userId);
    if (user?.appearance?.trim()) {
      const shouldInclude = includeUser !== undefined ? includeUser : true;
      if (shouldInclude) {
        charBlocks.push(`Name: ${user.displayName} (the user)\nAppearance: ${user.appearance.trim()}`);
      }
    }
  }

  // Personajes del contexto (PNJs): no están en el roster de la conversación,
  // pero aparecen en la escena (detectados en el índice de contexto o en el
  // diálogo del narrador y seleccionados por el usuario en el modal). Si traen
  // descripción se usa; si no, se instruye al LLM a inferir una apariencia
  // coherente a partir de la propia escena en vez de omitir al personaje.
  const dedupedExtras = (extraCharacters ?? []).filter(
    (x, i, arr) =>
      x.name.trim() &&
      arr.findIndex((y) => y.name.trim().toLowerCase() === x.name.trim().toLowerCase()) === i &&
      !characters.some((c) => c!.name.toLowerCase() === x.name.trim().toLowerCase()),
  );
  for (const extra of dedupedExtras) {
    const lines = [`Name: ${extra.name.trim()} (secondary character from the scene)`];
    if (extra.description?.trim()) {
      lines.push(`Description: ${extra.description.trim()}`);
    } else {
      lines.push(
        `Appearance: not defined — infer a plausible, consistent appearance from how this character is described, addressed or acts in the RECENT SCENE below`,
      );
    }
    charBlocks.push(lines.join('\n'));
  }

  const charactersBlock = charBlocks.join('\n\n');

  const allMessages  = msgRepo.findByConversation(conversationId);
  const clickedIdx   = allMessages.findIndex((m) => m.id === messageId);
  const contextSlice = allMessages
    .slice(0, clickedIdx >= 0 ? clickedIdx + 1 : undefined)
    .filter((m) => m.role !== 'system')
    .slice(-Math.max(1, messageCount));

  // Build a set of character names that are actually selected (for message labelling)
  const selectedCharNames = new Set(characters.filter(Boolean).map((c) => c!.name));

  // Determine user inclusion
  const userExcluded = userId
    ? (includeUser !== undefined ? !includeUser : false)
    : true;

  const charNameMap  = new Map(characters.filter(Boolean).map((c) => [c!.id, c!.name]));
  const fmtMessage = (m: (typeof contextSlice)[number]): string => {
    if (m.role === 'user') {
      // When user is excluded from the image, label their lines as off-screen narrative
      // so the LLM doesn't place them physically in the scene
      const speaker = userExcluded ? 'Narrator (off-screen)' : 'User';
      return `${speaker}: ${m.content}`;
    }
    const charName = m.characterId ? (charNameMap.get(m.characterId) ?? 'Character') : 'Character';
    return `${charName}: ${m.content}`;
  };

  // Ancla ponderada: el mensaje pinchado es EL instante a representar; los previos
  // solo aportan continuidad (lugar, vestuario, ánimo), no son beats a dibujar.
  // Sin esto, los N mensajes entraban planos y el director no sabía qué momento
  // componer → escenas genéricas.
  const anchorMsg = contextSlice[contextSlice.length - 1];
  const leadUp    = contextSlice.slice(0, -1);
  const messagesBlock = [
    leadUp.length
      ? `LEAD-UP (context only — for continuity of setting, wardrobe and mood; do NOT depict these earlier beats):\n${leadUp.map(fmtMessage).join('\n\n')}`
      : '',
    anchorMsg
      ? `>>> THE MOMENT TO DEPICT — build the whole image around THIS beat:\n${fmtMessage(anchorMsg)}`
      : '',
  ].filter(Boolean).join('\n\n');

  const promptTemplate = settings.get('sceneImagePrompt') as string;
  const filledPrompt = promptTemplate
    .replace('{{characters}}', charactersBlock || '(no character info available)')
    .replace('{{messages}}',   messagesBlock   || '(no messages)');

  // ── Setting / ubicación (continuidad de fondo) ───────────────────────────
  // La escena hereda la ubicación actual de la conversación; si una historia
  // vinculada define esa localización, se añade su atmósfera para un fondo estable.
  let locationBlock = '';
  const currentLoc = conversation.currentLocation?.trim();
  if (currentLoc) {
    let atmosphere = '';
    try {
      const storyRepo = new StoryRepository();
      for (const sl of conversation.stories) {
        const story = storyRepo.findById(sl.storyId);
        const loc = story?.locations?.find((l) => l.name.trim().toLowerCase() === currentLoc.toLowerCase());
        if (loc) {
          atmosphere = [loc.description, loc.atmosphere].map((s) => s?.trim()).filter(Boolean).join(' — ');
          break;
        }
      }
    } catch { /* la ubicación por nombre ya es suficiente */ }
    locationBlock = `\n\nSETTING — where this scene takes place (keep the background consistent with it):\n${currentLoc}${atmosphere ? `\n${atmosphere}` : ''}`;
  }

  // ── Explicit character constraint (appended AFTER the template) ──────────
  // This overrides any inference the LLM might make from the message context.
  const includedNames: string[] = [...selectedCharNames];
  if (!userExcluded && userId) {
    const u = getUserById(userId);
    if (u?.appearance?.trim()) includedNames.push(u.displayName);
  }
  includedNames.push(...dedupedExtras.map((x) => x.name.trim()));

  const constraintBlock = includedNames.length > 0
    ? `\n\nCRITICAL CONSTRAINT — CHARACTERS IN THE IMAGE:\nOnly portray the following characters: ${includedNames.join(', ')}.\nDo NOT portray any other person, character or figure, even if they appear in the dialogue above.`
    : '';

  return filledPrompt + locationBlock + constraintBlock + DYNAMISM_BLOCK;
}

export const generateRoutes: FastifyPluginAsync = async (app) => {
  app.post('/stream', async (req, reply) => {
    const result = generateSchema.safeParse(req.body);
    if (!result.success) throw new ValidationError(result.error.issues[0].message);

    const { conversationId, message, characterId, branchId, narratorMode, overrides } = result.data;

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    // Los pasos de enriquecimiento de fondo (director de escena, resúmenes…)
    // ahora se ejecutan DENTRO de generateStream() —ya no fire-and-forget— para
    // poder avisar al cliente de cada uno ("paso 2/3: ..."). Eso mantiene esta
    // conexión SSE abierta bastante más tiempo que antes (varias llamadas al LLM
    // en fila), así que send() debe tolerar que el socket ya no esté vivo — el
    // usuario pudo cerrar la pestaña mientras el enriquecimiento seguía en curso.
    const send = (data: object) => {
      if (reply.raw.writableEnded || reply.raw.destroyed) return;
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    };
    // Sin este listener, escribir en un socket cuyo otro extremo ya cerró puede
    // emitir un 'error' no gestionado en el ServerResponse y tumbar el proceso.
    reply.raw.on('error', (err) => {
      console.warn('[generate/stream] Error de escritura en la conexión SSE (probablemente el cliente ya cerró):', err.message);
    });

    // Detect client disconnect (user clicked Stop or navigated away).
    // Must listen on reply.raw (ServerResponse), NOT req.raw (IncomingMessage) —
    // the request emits 'close' right after the body is parsed, which would
    // trigger an immediate abort before any tokens arrive.
    const abortController = new AbortController();
    reply.raw.on('close', () => {
      if (!reply.raw.writableEnded) abortController.abort();
    });

    const { displayName: userDisplayName } = (req as any).authUser ?? {};

    await generateStream({
      conversationId,
      userMessage: message,
      characterId,
      branchId,
      narratorMode,
      userDisplayName,
      overrides,
      signal: abortController.signal,
      onToken: (token) => send({ type: 'token', token }),
      onThinkToken: (token) => send({ type: 'think', token }),
      onDone: ({ messageId, userMessageId, tokens, tokenBreakdown, promptMessages, affinityUpdates, fastLlmDebug, narrator, characterId, content, locationUpdate, thinkContent, deathLoop, diceRoll }) => {
        send({ type: 'done', messageId, userMessageId, tokens, tokenBreakdown, promptMessages, affinityUpdates, fastLlmDebug, narrator, characterId, content, locationUpdate, thinkContent, deathLoop, diceRoll });
        // OJO: la conexión NO se cierra aquí. El mensaje ya es visible e
        // interactivo para el usuario (el store del cliente marca isStreaming =
        // false al recibir este evento), pero la conexión sigue abierta para
        // los eventos 'enrich_step'/'enrich_done' que vienen a continuación —
        // se cierra al final del handler, cuando generateStream() resuelve.
      },
      onEnrichStep: ({ index, total, label }) => send({ type: 'enrich_step', index, total, label }),
      onEnrichDone: () => send({ type: 'enrich_done' }),
      onError: (error) => {
        send({ type: 'error', error: error.message });
        reply.raw.end();
      },
    });

    // Cierra la conexión al terminar TODO (respuesta + enriquecimiento de fondo).
    // Con guardia por si el camino de error ya la cerró antes.
    if (!reply.raw.writableEnded) reply.raw.end();
  });

  app.post('/sync', async (req) => {
    const result = generateSchema.safeParse(req.body);
    if (!result.success) throw new ValidationError(result.error.issues[0].message);

    const { conversationId, message, characterId, branchId, narratorMode, overrides } = result.data;

    return new Promise((resolve, reject) => {
      let fullContent = '';
      let finalMessageId = '';
      let finalTokens = 0;

      generateStream({
        conversationId,
        userMessage: message,
        characterId,
        branchId,
        narratorMode,
        overrides,
        onToken: (token) => { fullContent += token; },
        onDone: ({ messageId, tokens }) => {
          finalMessageId = messageId;
          finalTokens = tokens;
          resolve({ success: true, data: { content: fullContent, messageId: finalMessageId, tokens: finalTokens } });
        },
        onError: reject,
      });
    });
  });

  // ── POST /generate/scene-image ────────────────────────────────────────────
  // 1. Builds a scene-description prompt from conversation context + characters
  // 2. Calls the active LLM to get an English image prompt
  // 3. Sends that prompt to ComfyUI and saves the result
  // 4. Stores the image URL in the message's metadata and returns it
  app.post('/scene-image', async (req, reply) => {
    const body = z.object({
      conversationId:    z.string(),
      messageId:         z.string(),
      workflowName:      z.string().optional(),
      customPrompt:      z.string().optional(),   // skip LLM step if provided
      useFaceReference:  z.boolean().optional(),  // BETA: use character avatar as FaceID reference
      referenceCharId:   z.string().optional(),   // which character to use as reference
    }).parse(req.body);

    const {
      conversationId, messageId,
      workflowName = 'image_z_image_turbo',
      customPrompt,
      useFaceReference = false,
      referenceCharId,
    } = body;

    const msgRepo  = new MessageRepository();
    const provRepo = new ProviderRepository();
    const settings = new SettingsService();

    const message = msgRepo.findById(messageId);
    if (!message) throw new NotFoundError('Message', messageId);

    // ── Call LLM (unless a custom prompt was provided directly) ──────────
    let sceneDescription: string;

    if (customPrompt?.trim()) {
      sceneDescription = customPrompt.trim();
    } else {
      const userId = (req as any).authUser?.userId as string | undefined;
      const scenePrompt = await buildScenePromptText(conversationId, messageId, userId);

      const defaultProviderId = settings.get('defaultProviderId') as string | null;
      const defaultModelId    = settings.get('defaultModelId')    as string | null;

      const providerRecord = defaultProviderId
        ? provRepo.findById(defaultProviderId)
        : provRepo.findAll()[0] ?? null;

      if (!providerRecord) {
        throw new ValidationError('No hay ningún provider configurado. Configura uno en Settings → Providers.');
      }

      const llm = createProvider(providerRecord);
      const llmResponse = await llm.generate({
        messages: [{ role: 'user', content: scenePrompt }],
        model:    defaultModelId ?? '',
        stream:   false,
        temperature: 0.7,
      });

      sceneDescription = llmResponse.content.trim();
    }

    // ── Call image provider ───────────────────────────────────────────────
    const imageProvider = createImageProvider(settings.getAll());

    let generationResult: { buffer: Buffer; filename: string };

    if (useFaceReference) {
      if (!imageProvider.supportsReference) {
        throw new ValidationError(
          'El proveedor de imagen actual no soporta FaceID. ' +
          'Cambia a ComfyUI (local) en Ajustes → Providers para usar imágenes de referencia.'
        );
      }

      // BETA mode: find the reference character's avatar image
      const charRepo = new CharacterRepository();
      const convRepo = new ConversationRepository();
      const conversation = convRepo.findById(conversationId);

      // Use referenceCharId if provided, otherwise first character in conversation
      const charId = referenceCharId
        ?? conversation?.characters[0]?.characterId;
      const character = charId ? charRepo.findById(charId) : null;

      const avatarUrl = character?.avatar;
      if (!avatarUrl) {
        throw new ValidationError(
          'El personaje de referencia no tiene imagen de avatar. ' +
          'Genera o sube una imagen al personaje antes de usar el modo BETA.'
        );
      }

      // Convert URL path (/images/chars/...) to absolute disk path
      const avatarDiskPath = path.join(PROJECT_ROOT, 'data', 'images', avatarUrl.replace(/^\/images\//, ''));
      if (!fs.existsSync(avatarDiskPath)) {
        throw new ValidationError(`Imagen de avatar no encontrada en disco: ${avatarUrl}`);
      }

      try {
        generationResult = await imageProvider.generateWithReference!({
          prompt: sceneDescription,
          referenceImagePath: avatarDiskPath,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Surface ComfyUI missing-model errors with actionable instructions
        if (msg.includes('Modelo no encontrado') || msg.includes('not in []') || msg.includes('workflow inválido')) {
          throw new ValidationError(
            `${msg}\n\n` +
            `El modo BETA con imagen de referencia requiere un checkpoint SDXL en ComfyUI. ` +
            `Descarga un modelo SDXL (p.ej. dreamshaperXL_lightningDPMSDE.safetensors) y ` +
            `colócalo en la carpeta "checkpoints" de tu instalación de ComfyUI.`
          );
        }
        throw err;
      }
    } else {
      // ── Check for progressive workflow (preview + final) ─────────────────
      const comfyProvider = imageProvider as import('../../core/image/providers/comfyui.image-provider.js').ComfyUiImageProvider;
      const progressiveMeta = comfyProvider.getProgressiveMeta?.(workflowName);

      if (progressiveMeta) {
        // Progressive: return preview immediately, upscale in background
        const scenesDir = path.join(PROJECT_ROOT, 'data', 'images', 'scenes', conversationId);
        fs.mkdirSync(scenesDir, { recursive: true });
        const existingMeta = (message.metadata ?? {}) as Record<string, unknown>;

        const { waitForPreview, waitForFinal } = comfyProvider.startProgressiveGeneration(
          workflowName,
          sceneDescription,
          progressiveMeta.previewNodeId,
          progressiveMeta.finalNodeId,
        );

        // Wait for the quick preview image
        const previewResult = await waitForPreview();
        const previewExt = path.extname(previewResult.filename) || '.png';
        const previewFilename = `scene_${messageId.slice(0, 8)}_preview${previewExt}`;
        fs.writeFileSync(path.join(scenesDir, previewFilename), previewResult.buffer);
        const previewUrl = `/images/scenes/${conversationId}/${previewFilename}`;

        const genToken = Date.now().toString(36) + Math.random().toString(36).slice(2);
        const previewEntry: SceneImage = { url: previewUrl, pending: true, token: genToken, description: sceneDescription };
        const imagesAfterPreview = [...getSceneImages(existingMeta), previewEntry];
        msgRepo.update(messageId, { metadata: { ...existingMeta, sceneImages: imagesAfterPreview } });

        // Background: replace the preview entry with the final 4K image
        waitForFinal().then((finalResult) => {
          const latestMsg = msgRepo.findById(messageId);
          const latestMeta = (latestMsg?.metadata ?? {}) as Record<string, unknown>;
          const imgs = getSceneImages(latestMeta);
          const idx = imgs.findIndex(i => i.token === genToken);
          if (idx === -1) { console.log('[scene-image] Entrada eliminada, descartando 4K final'); return; }
          const finalExt = path.extname(finalResult.filename) || '.png';
          const finalFilename = `scene_${messageId.slice(0, 8)}_${genToken}_final${finalExt}`;
          fs.writeFileSync(path.join(scenesDir, finalFilename), finalResult.buffer);
          const finalUrl = `/images/scenes/${conversationId}/${finalFilename}`;
          const updated = [...imgs];
          updated[idx] = { url: finalUrl, description: sceneDescription };
          msgRepo.update(messageId, { metadata: { ...latestMeta, sceneImages: updated } });
          console.log(`[scene-image] 4K final guardado: ${finalUrl}`);
        }).catch((err) => {
          console.error('[scene-image] Error en upscale final:', err);
          const latestMsg = msgRepo.findById(messageId);
          const latestMeta = (latestMsg?.metadata ?? {}) as Record<string, unknown>;
          const imgs = getSceneImages(latestMeta);
          const idx = imgs.findIndex(i => i.token === genToken);
          if (idx === -1) return;
          const updated = [...imgs];
          updated[idx] = { ...updated[idx], pending: false };
          msgRepo.update(messageId, { metadata: { ...latestMeta, sceneImages: updated } });
        });

        return reply.send({
          success: true,
          data: { imageUrl: previewUrl, sceneDescription, pending: true },
        });
      }

      // Standard (non-progressive) generation
      generationResult = await imageProvider.generate({ prompt: sceneDescription, workflowName });
    }

    const { buffer, filename } = generationResult;

    // ── Save image ────────────────────────────────────────────────────────
    const scenesDir = path.join(PROJECT_ROOT, 'data', 'images', 'scenes', conversationId);
    fs.mkdirSync(scenesDir, { recursive: true });

    const ext = path.extname(filename) || '.png';
    const fileToken = Date.now().toString(36) + Math.random().toString(36).slice(2);
    const savedFilename = `scene_${messageId.slice(0, 8)}_${fileToken}${ext}`;
    fs.writeFileSync(path.join(scenesDir, savedFilename), buffer);

    const imageUrl = `/images/scenes/${conversationId}/${savedFilename}`;

    // ── Append to sceneImages array ───────────────────────────────────────
    const existingMeta2 = (message.metadata ?? {}) as Record<string, unknown>;
    const newEntry: SceneImage = { url: imageUrl, description: sceneDescription };
    msgRepo.update(messageId, {
      metadata: { ...existingMeta2, sceneImages: [...getSceneImages(existingMeta2), newEntry] },
    });

    return reply.send({
      success: true,
      data: { imageUrl, sceneDescription },
    });
  });

  // ── POST /generate/build-scene-prompt ────────────────────────────────────
  // Returns the full prompt text that WOULD be sent to the LLM, without calling it.
  // Used by the debug modal so the user can review/edit before LLM call.
  app.post('/build-scene-prompt', async (req, reply) => {
    const { conversationId, messageId, selectedCharacterIds, includeUser, messageCount, extraCharacters } = z.object({
      conversationId:       z.string(),
      messageId:            z.string(),
      selectedCharacterIds: z.array(z.string()).optional(),
      includeUser:          z.boolean().optional(),
      messageCount:         z.number().int().min(1).max(30).optional(),
      extraCharacters:      z.array(z.object({
        name:        z.string().min(1).max(80),
        description: z.string().max(2000).optional(),
      })).max(10).optional(),
    }).parse(req.body);

    const userId = (req as any).authUser?.userId as string | undefined;
    const scenePrompt = await buildScenePromptText(
      conversationId, messageId, userId, selectedCharacterIds, includeUser, messageCount, extraCharacters,
    );
    return reply.send({ success: true, data: { scenePrompt } });
  });

  // ── POST /generate/run-llm-prompt ─────────────────────────────────────────
  // Calls the default LLM with an arbitrary prompt and returns the raw result.
  // Used by the debug modal's "Generar prompt de imagen" step.
  app.post('/run-llm-prompt', async (req, reply) => {
    const { prompt } = z.object({
      prompt: z.string().min(1),
    }).parse(req.body);

    const provRepo = new ProviderRepository();
    const settings = new SettingsService();

    const defaultProviderId = settings.get('defaultProviderId') as string | null;
    const defaultModelId    = settings.get('defaultModelId')    as string | null;

    const providerRecord = defaultProviderId
      ? provRepo.findById(defaultProviderId)
      : provRepo.findAll()[0] ?? null;

    if (!providerRecord) {
      throw new ValidationError('No hay ningún provider configurado. Configura uno en Settings → Providers.');
    }

    const llm = createProvider(providerRecord);
    const llmResponse = await llm.generate({
      messages:    [{ role: 'user', content: prompt }],
      model:       defaultModelId ?? '',
      stream:      false,
      temperature: 0.7,
    });

    return reply.send({ success: true, data: { result: llmResponse.content.trim() } });
  });

  // ── POST /generate/analyze ───────────────────────────────────────────────
  // Re-runs the fast-LLM analysis for an existing assistant message (retry).
  app.post('/analyze', async (req, reply) => {
    const { messageId } = z.object({ messageId: z.string() }).parse(req.body);

    const msgRepo  = new MessageRepository();
    const convRepo = new ConversationRepository();
    const charRepo = new CharacterRepository();
    const provRepo = new ProviderRepository();
    const memRepo  = new MemoryRepository();
    const settings = new SettingsService();

    const message = msgRepo.findById(messageId);
    if (!message) throw new NotFoundError('Message', messageId);
    if (message.role !== 'assistant') throw new ValidationError('El mensaje no es de un asistente');

    const conversation = convRepo.findById(message.conversationId);
    if (!conversation) throw new NotFoundError('Conversation', message.conversationId);

    const fastProviderId = settings.get('fastLlmProviderId') as string | null;
    const fastModelId    = settings.get('fastLlmModelId')    as string | null;
    const promptTemplate = settings.get('fastLlmAnalysisPrompt') as string;

    if (!fastProviderId || !fastModelId) {
      throw new ValidationError('El LLM Rápido no está configurado en Ajustes → Generation');
    }

    // Find the preceding user message in the same branch
    const allMessages = msgRepo.findByConversation(message.conversationId, message.branchId ?? 'main');
    const msgIndex    = allMessages.findIndex((m) => m.id === messageId);
    const userMsg     = [...allMessages].slice(0, msgIndex).reverse().find((m) => m.role === 'user');
    if (!userMsg) throw new ValidationError('No se encontró el mensaje del usuario anterior');

    // Gather characters + current affinities
    const allCharsInConv = conversation.characters
      .map((l: { characterId: string }) => charRepo.findById(l.characterId))
      .filter(Boolean) as NonNullable<ReturnType<typeof charRepo.findById>>[];

    const characterAffinities = conversation.characters
      .map((l: { characterId: string; affinity: number }) => {
        const char = charRepo.findById(l.characterId);
        return char ? { characterId: l.characterId, name: char.name, affinity: l.affinity } : null;
      })
      .filter(Boolean) as { characterId: string; name: string; affinity: number }[];

    const fastProvider = provRepo.findById(fastProviderId);
    if (!fastProvider || !fastProvider.isEnabled) {
      throw new ValidationError('El provider del LLM Rápido no está disponible o está desactivado');
    }

    const llm = createProvider(fastProvider);

    const charLines = characterAffinities
      .map(({ name, affinity }) => `- ${name} (afinidad: ${affinity}/100)`)
      .join('\n');

    const analysisPrompt = promptTemplate
      .replace('{{PERSONAJES}}', charLines)
      .replace('{{MENSAJE_JUGADOR}}', userMsg.content)
      .replace('{{RESPUESTA}}', message.content);

    // 60-second timeout
    const timeoutHandle = { fired: false };
    const timeoutPromise = new Promise<null>((resolve) =>
      setTimeout(() => { timeoutHandle.fired = true; resolve(null); }, 60_000)
    );

    const llmResult = await Promise.race([
      llm.generate({
        messages: [
          { role: 'system', content: 'Eres un analizador de eventos de juego de rol. Responde solo con las etiquetas indicadas o la palabra NINGUNO.' },
          { role: 'user', content: analysisPrompt },
        ],
        model: fastModelId,
        temperature: 0.1,
        maxTokens: 512,
        stream: false,
      }),
      timeoutPromise,
    ]);

    if (!llmResult) {
      throw new ValidationError('El LLM Rápido tardó más de 60 segundos. Comprueba que el modelo está cargado.');
    }

    const responseText = (llmResult as { content: string }).content;
    console.log(`[fast-llm retry] Response: ${responseText.slice(0, 200)}${responseText.length > 200 ? '…' : ''}`);

    // Parse memory entries
    const MEMORY_RE = /\[MEMORIA:([^:]+):([^:]+):(\d+)\]([\s\S]+?)\[\/MEMORIA\]/g;
    const TYPE_MAP: Record<string, MemoryEntry['type']> = {
      evento: 'event', hecho: 'fact', relacion: 'relationship', preferencia: 'preference',
      ofensa: 'offense', trauma: 'trauma',
    };
    for (const match of [...responseText.matchAll(MEMORY_RE)]) {
      const charName   = match[1].trim();
      const typeRaw    = match[2].trim().toLowerCase();
      const importance = parseInt(match[3], 10);
      const content    = match[4].trim();
      if (importance < 8) continue;
      const found = allCharsInConv.find((c) => c.name.toLowerCase() === charName.toLowerCase());
      if (!found) continue;
      memRepo.create({
        conversationId: message.conversationId,
        characterId: found.id,
        type: TYPE_MAP[typeRaw] ?? 'event',
        content,
        importance,
        isActive: true,
      });
    }

    // Parse affinity updates (with safety guardrail)
    const SEXUAL_VEXATIOUS_RE =
      /\b(foll\w*|viola\w*|violaci[oó]n|abus[ao]\w*|acoso\w*|coger\w*|penetr\w*|chup\w*\s+mi|mamar\w*|masturb\w*|correrse|culo\w*|polla\w*|pene\w*|verga\w*|tetas?|desnud\w*|sexo\s+forz\w*|me\s+voy\s+a\s+(coger|follar|violar)|voy\s+a\s+\w*(follar|violar|coger)\w*|te\s+voy\s+a\s+\w*(follar|violar|poseer)\w*)\b/i;
    const playerHasSexualOrAbusiveIntent = SEXUAL_VEXATIOUS_RE.test(userMsg.content);

    const AFFINITY_RE = /\[AFINIDAD:([^\]:\n]+):([+-]?\d+)\]/g;
    const affinityUpdates: { characterId: string; newAffinity: number }[] = [];
    for (const match of [...responseText.matchAll(AFFINITY_RE)]) {
      const name  = match[1].trim();
      let delta   = parseInt(match[2], 10);
      const found = matchCharacterName(name, allCharsInConv);
      if (!found) continue;
      if (Math.abs(delta) < 8) continue; // ignore micro-deltas
      const current = characterAffinities.find((a) => a.characterId === found.id)?.affinity ?? 50;
      if (playerHasSexualOrAbusiveIntent && current < 80 && delta > 0) {
        console.warn(`[fast-llm retry] ⚠ Safety override: flipping +${delta} to -${Math.abs(delta) + 5} for "${found.name}"`);
        delta = -(Math.abs(delta) + 5);
      }
      const newAffinity = Math.max(1, Math.min(100, current + delta));
      convRepo.updateCharacterAffinity(message.conversationId, found.id, newAffinity);
      affinityUpdates.push({ characterId: found.id, newAffinity });
    }

    // Always persist the result so it survives a page reload
    const existingMeta = (message.metadata ?? {}) as Record<string, unknown>;
    msgRepo.update(messageId, {
      metadata: { ...existingMeta, fastLlmDebug: { prompt: analysisPrompt, response: responseText } },
    });

    return reply.send({ success: true, data: { rawResponse: responseText, rawPrompt: analysisPrompt, affinityUpdates } });
  });

  // ── DELETE /generate/scene-image ─────────────────────────────────────────
  // Removes a specific scene image (by URL) from the message's sceneImages array
  app.delete('/scene-image', async (req, reply) => {
    const body = z.object({
      conversationId: z.string(),
      messageId:      z.string(),
      imageUrl:       z.string(),
    }).parse(req.body);

    const { conversationId, messageId, imageUrl } = body;

    const msgRepo = new MessageRepository();
    const message = msgRepo.findById(messageId);
    if (!message) throw new NotFoundError('Message', messageId);

    // Delete the file from disk
    const relPath  = imageUrl.replace(/^\/images\//, '');
    const filePath = path.join(PROJECT_ROOT, 'data', 'images', relPath);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

    // Remove from sceneImages array (token removal ensures in-flight background tasks are aborted)
    const meta = (message.metadata as Record<string, unknown>) ?? {};
    const remaining = getSceneImages(meta).filter(i => i.url !== imageUrl);
    const cleaned = { ...meta };
    // Drop legacy fields if they match the deleted URL
    if (cleaned.sceneImageUrl === imageUrl) {
      delete cleaned.sceneImageUrl;
      delete cleaned.sceneDescription;
      delete cleaned.sceneImagePending;
      delete cleaned.sceneImageToken;
    }
    cleaned.sceneImages = remaining;
    msgRepo.update(messageId, { metadata: cleaned });

    void conversationId;
    return reply.send({ success: true });
  });

  // ── POST /generate/upload-scene-image ────────────────────────────────────
  // Permite subir una imagen externa para asociarla a un mensaje del chat,
  // igual que si hubiera sido generada por IA. Los parámetros van como query.
  app.post('/upload-scene-image', async (req, reply) => {
    const { conversationId, messageId } = req.query as { conversationId?: string; messageId?: string };
    if (!conversationId || !messageId) {
      throw new ValidationError('conversationId y messageId son requeridos como query params');
    }

    const fileData = await req.file();
    if (!fileData) throw new ValidationError('No se recibió ningún archivo');

    const allowed = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif'];
    if (!allowed.includes(fileData.mimetype)) {
      throw new ValidationError('Tipo de archivo no permitido. Usa JPG, PNG, WebP o GIF.');
    }

    const buffer = await fileData.toBuffer();
    if (buffer.length > 20 * 1024 * 1024) {
      throw new ValidationError('La imagen no puede superar 20 MB.');
    }

    const msgRepo = new MessageRepository();
    const message = msgRepo.findById(messageId);
    if (!message) throw new NotFoundError('Message', messageId);

    // Guardar junto a las imágenes generadas (mismo directorio)
    const scenesDir = path.join(PROJECT_ROOT, 'data', 'images', 'scenes', conversationId);
    fs.mkdirSync(scenesDir, { recursive: true });

    const ext = path.extname(fileData.filename).toLowerCase() || '.jpg';
    const savedFilename = `upload_${messageId.slice(0, 8)}_${Date.now()}${ext}`;
    fs.writeFileSync(path.join(scenesDir, savedFilename), buffer);

    const imageUrl = `/images/scenes/${conversationId}/${savedFilename}`;

    // Append to sceneImages array
    const existingMeta = (message.metadata ?? {}) as Record<string, unknown>;
    const uploadEntry: SceneImage = { url: imageUrl };
    msgRepo.update(messageId, {
      metadata: { ...existingMeta, sceneImages: [...getSceneImages(existingMeta), uploadEntry] },
    });

    return reply.send({ success: true, data: { imageUrl } });
  });

  // ── POST /generate/user-inspiration ──────────────────────────────────────
  // Generates a new portrait image using the user avatar as FaceID reference
  // and their appearance description as the positive prompt.
  app.post("/user-inspiration", async (req, reply) => {
    const userId = ((req as any).authUser as { userId: string } | undefined)?.userId;
    if (!userId) throw new ValidationError("No autenticado");

    const { customPrompt } = z.object({
      customPrompt: z.string().optional(),
    }).parse(req.body);

    const user = getUserById(userId);
    if (!user) throw new ValidationError("Usuario no encontrado");

    if (!user.avatar) {
      throw new ValidationError(
        "Necesitas subir una foto de perfil antes de usar Inspiración. " +
        "Sube una imagen en tu perfil e inténtalo de nuevo.",
      );
    }

    const avatarDiskPath = path.join(
      PROJECT_ROOT, "data", "images",
      user.avatar.replace(/^\/images\//, ""),
    );
    if (!fs.existsSync(avatarDiskPath)) {
      throw new ValidationError("No se encontró el archivo de avatar en disco. Sube una nueva foto.");
    }

    const positivePrompt =
      customPrompt?.trim() ||
      user.appearance?.trim() ||
      `portrait photo of ${user.displayName}, photorealistic, high quality`;

    const settings = new SettingsService();
    const imageProvider = createImageProvider(settings.getAll());

    let buffer: Buffer;
    let filename: string;

    if (imageProvider.supportsReference) {
      // ComfyUI: use FaceID with the user's avatar as reference
      ({ buffer, filename } = await imageProvider.generateWithReference!({
        prompt: positivePrompt,
        referenceImagePath: avatarDiskPath,
      }));
    } else {
      // External provider: generate using text description only (no FaceID)
      ({ buffer, filename } = await imageProvider.generate({ prompt: positivePrompt }));
    }

    const inspiredDir = path.join(PROJECT_ROOT, "data", "images", "users", userId, "inspired");
    fs.mkdirSync(inspiredDir, { recursive: true });
    const ext = path.extname(filename) || ".png";
    const savedFilename = `inspired_${Date.now()}${ext}`;
    fs.writeFileSync(path.join(inspiredDir, savedFilename), buffer);

    const imageUrl = `/images/users/${userId}/inspired/${savedFilename}`;
    return reply.send({ success: true, data: { imageUrl } });
  });

  // ── POST /generate/scene-image-sse ────────────────────────────────────────
  // Like scene-image but streams SSE events with real-time ComfyUI progress.
  // Events: status | progress | preview | done | error
  app.post('/scene-image-sse', async (req, reply) => {
    const body = z.object({
      conversationId:   z.string(),
      messageId:        z.string(),
      workflowName:     z.string().optional(),
      customPrompt:     z.string().optional(),
      useFaceReference: z.boolean().optional(),
      referenceCharId:  z.string().optional(),
      loraName:         z.string().optional(),
      loraStrength:     z.number().min(0).max(2).optional(),
      megapixel:        z.string().optional(),
      aspectRatio:      z.string().optional(),
      baseModel:        z.string().optional(),
      powerLoraUpdates: z.array(z.object({
        key: z.string(),
        on: z.boolean(),
        strength: z.number().optional(),
      })).optional(),
    }).parse(req.body);

    const {
      conversationId, messageId,
      workflowName = 'image_z_image_turbo',
      customPrompt,
      useFaceReference = false,
      loraName,
      loraStrength,
      megapixel,
      aspectRatio,
      baseModel,
      powerLoraUpdates,
    } = body;

    reply.raw.writeHead(200, {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection':    'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const send = (data: object) => {
      try { reply.raw.write(`data: ${JSON.stringify(data)}\n\n`); } catch { /* client gone */ }
    };

    try {
      const msgRepo  = new MessageRepository();
      const provRepo = new ProviderRepository();
      const settings = new SettingsService();

      const message = msgRepo.findById(messageId);
      if (!message) { send({ type: 'error', message: 'Mensaje no encontrado' }); reply.raw.end(); return; }

      // ── Step 1: build image prompt ───────────────────────────────────────
      let sceneDescription: string;
      if (customPrompt?.trim()) {
        sceneDescription = customPrompt.trim();
      } else {
        send({ type: 'status', message: 'Describiendo la escena…' });
        const userId = (req as any).authUser?.userId as string | undefined;
        const scenePrompt = await buildScenePromptText(conversationId, messageId, userId);
        const defaultProviderId = settings.get('defaultProviderId') as string | null;
        const defaultModelId    = settings.get('defaultModelId')    as string | null;
        const providerRecord = defaultProviderId
          ? provRepo.findById(defaultProviderId)
          : provRepo.findAll()[0] ?? null;
        if (!providerRecord) {
          send({ type: 'error', message: 'No hay provider configurado' });
          reply.raw.end(); return;
        }
        const llm = createProvider(providerRecord);
        const llmResponse = await llm.generate({
          messages: [{ role: 'user', content: scenePrompt }],
          model: defaultModelId ?? '',
          temperature: 0.7,
          stream: false,
        });
        sceneDescription = llmResponse.content.trim();
      }

      send({ type: 'status', message: 'Enviando a ComfyUI…' });

      // ── Step 2: generate image ───────────────────────────────────────────
      const allSettings = settings.getAll();
      const comfyProvider = createImageProvider(allSettings) as import('../../core/image/providers/comfyui.image-provider.js').ComfyUiImageProvider;
      const progressiveMeta = comfyProvider.getProgressiveMeta?.(workflowName);

      const scenesDir = path.join(PROJECT_ROOT, 'data', 'images', 'scenes', conversationId);
      fs.mkdirSync(scenesDir, { recursive: true });
      const existingMeta = (message.metadata ?? {}) as Record<string, unknown>;

      if (progressiveMeta) {
        const { waitForPreview, waitForFinal, disconnect } = await comfyProvider.startProgressiveWithProgress(
          workflowName,
          sceneDescription,
          progressiveMeta.previewNodeId,
          progressiveMeta.finalNodeId,
          (evt) => {
            if (evt.type === 'progress') {
              send({ type: 'progress', value: evt.value, max: evt.max });
            } else if (evt.type === 'node') {
              send({ type: 'node', nodeId: evt.nodeId, nodeName: evt.nodeName });
            }
          },
          { megapixel, aspectRatio },
        );

        // Close WS if client disconnects
        reply.raw.on('close', () => disconnect());

        // Preview
        const previewResult = await waitForPreview();
        const previewExt = path.extname(previewResult.filename) || '.png';
        const previewFilename = `scene_${messageId.slice(0, 8)}_preview${previewExt}`;
        fs.writeFileSync(path.join(scenesDir, previewFilename), previewResult.buffer);
        const previewUrl = `/images/scenes/${conversationId}/${previewFilename}`;
        const sseGenToken = Date.now().toString(36) + Math.random().toString(36).slice(2);
        const ssePreviewEntry: SceneImage = { url: previewUrl, pending: true, token: sseGenToken, description: sceneDescription };
        msgRepo.update(messageId, { metadata: { ...existingMeta, sceneImages: [...getSceneImages(existingMeta), ssePreviewEntry] } });
        send({ type: 'preview', imageUrl: previewUrl, sceneDescription });

        // Final (background — don't await before ending SSE)
        waitForFinal().then((finalResult) => {
          const latestMeta = (msgRepo.findById(messageId)?.metadata ?? {}) as Record<string, unknown>;
          const imgs = getSceneImages(latestMeta);
          const idx = imgs.findIndex(i => i.token === sseGenToken);
          if (idx === -1) { console.log('[scene-image] SSE entrada eliminada, descartando 4K final'); return; }
          const finalExt = path.extname(finalResult.filename) || '.png';
          const finalFilename = `scene_${messageId.slice(0, 8)}_${sseGenToken}_final${finalExt}`;
          fs.writeFileSync(path.join(scenesDir, finalFilename), finalResult.buffer);
          const finalUrl = `/images/scenes/${conversationId}/${finalFilename}`;
          const updatedImgs = [...imgs];
          updatedImgs[idx] = { url: finalUrl, description: sceneDescription };
          msgRepo.update(messageId, { metadata: { ...latestMeta, sceneImages: updatedImgs } });
          send({ type: 'done', imageUrl: finalUrl, sceneDescription });
          reply.raw.end();
        }).catch((err) => {
          const latestMeta = (msgRepo.findById(messageId)?.metadata ?? {}) as Record<string, unknown>;
          const imgs = getSceneImages(latestMeta);
          const idx = imgs.findIndex(i => i.token === sseGenToken);
          if (idx === -1) return;
          const updatedImgs = [...imgs];
          updatedImgs[idx] = { ...updatedImgs[idx], pending: false };
          msgRepo.update(messageId, { metadata: { ...latestMeta, sceneImages: updatedImgs } });
          send({ type: 'error', message: `Error en upscale: ${err instanceof Error ? err.message : err}` });
          reply.raw.end();
        });

      } else {
        // Non-progressive workflow — use generateWithProgress if available (e.g. bzComfy)
        const anyProvider = comfyProvider as { generateWithProgress?: Function };
        const imageReq = { prompt: sceneDescription, workflowName, loraName, loraStrength, megapixel, aspectRatio, baseModel, powerLoraUpdates };
        const result = anyProvider.generateWithProgress
          ? await anyProvider.generateWithProgress(
              imageReq,
              (evt: { type: string; value?: number; max?: number; nodeId?: string; nodeName?: string; dataUrl?: string }) => {
                if (evt.type === 'progress') send({ type: 'progress', value: evt.value, max: evt.max });
                else if (evt.type === 'node') send({ type: 'node', nodeId: evt.nodeId, nodeName: evt.nodeName });
                else if (evt.type === 'preview') send({ type: 'latentPreview', dataUrl: evt.dataUrl });
              },
            )
          : await comfyProvider.generate(imageReq);
        const ext = path.extname(result.filename) || '.png';
        const sseFileToken = Date.now().toString(36) + Math.random().toString(36).slice(2);
        const savedFilename = `scene_${messageId.slice(0, 8)}_${sseFileToken}${ext}`;
        fs.writeFileSync(path.join(scenesDir, savedFilename), result.buffer);
        const imageUrl = `/images/scenes/${conversationId}/${savedFilename}`;
        const sseMeta = (msgRepo.findById(messageId)?.metadata ?? {}) as Record<string, unknown>;
        const sseEntry: SceneImage = { url: imageUrl, description: sceneDescription };
        msgRepo.update(messageId, { metadata: { ...sseMeta, sceneImages: [...getSceneImages(sseMeta), sseEntry] } });
        send({ type: 'done', imageUrl, sceneDescription });
        reply.raw.end();
      }

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      send({ type: 'error', message: msg });
      reply.raw.end();
    }
  });

  // ── Background image generation (per-conversation) ──────────────────────
  // Backgrounds are stored in conversation.metadata.backgroundGallery / .background

  // POST /generate/background-image-sse — generates a background image and appends it to the gallery
  app.post('/background-image-sse', async (req, reply) => {
    const body = z.object({
      conversationId: z.string(),
      prompt:         z.string().min(1),
      workflowName:   z.string().optional(),
      loraName:       z.string().optional(),
      loraStrength:   z.number().min(0).max(2).optional(),
      width:          z.number().int().positive(),
      height:         z.number().int().positive(),
    }).parse(req.body);

    const { conversationId, prompt, workflowName, loraName, loraStrength, width, height } = body;

    reply.raw.writeHead(200, {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection':    'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const send = (data: object) => {
      try { reply.raw.write(`data: ${JSON.stringify(data)}\n\n`); } catch { /* client gone */ }
    };

    try {
      const convRepo = new ConversationRepository();
      const settings = new SettingsService();

      const conversation = convRepo.findById(conversationId);
      if (!conversation) { send({ type: 'error', message: 'Conversación no encontrada' }); reply.raw.end(); return; }

      send({ type: 'status', message: 'Enviando a generador de imágenes…' });

      const imageProvider = createImageProvider(settings.getAll());
      const imageReq = { prompt, workflowName, loraName, loraStrength, width, height };

      const result = imageProvider.generateWithProgress
        ? await imageProvider.generateWithProgress(
            imageReq,
            (evt) => {
              if (evt.type === 'progress') send({ type: 'progress', value: evt.value, max: evt.max });
              else if (evt.type === 'node') send({ type: 'node', nodeId: evt.nodeId, nodeName: evt.nodeName });
              else if (evt.type === 'preview') send({ type: 'latentPreview', dataUrl: evt.dataUrl });
            },
          )
        : await imageProvider.generate(imageReq);

      const bgDir = path.join(PROJECT_ROOT, 'data', 'images', 'backgrounds', conversationId);
      fs.mkdirSync(bgDir, { recursive: true });

      const ext = path.extname(result.filename) || '.png';
      const id = Date.now().toString(36) + Math.random().toString(36).slice(2);
      const savedFilename = `bg_${id}${ext}`;
      fs.writeFileSync(path.join(bgDir, savedFilename), result.buffer);
      const url = `/images/backgrounds/${conversationId}/${savedFilename}`;

      const entry: BackgroundImage = { id, url, prompt, width, height, createdAt: new Date().toISOString() };

      const meta = (conversation.metadata ?? {}) as Record<string, unknown>;
      const gallery = Array.isArray(meta.backgroundGallery) ? meta.backgroundGallery as BackgroundImage[] : [];
      convRepo.update(conversationId, { metadata: { ...meta, backgroundGallery: [...gallery, entry] } });

      send({ type: 'done', image: entry });
      reply.raw.end();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      send({ type: 'error', message: msg });
      reply.raw.end();
    }
  });

  // POST /generate/upload-background-image — sube una imagen externa a la galería de fondos
  // Mismo flujo que la generación por IA pero sin prompt: guarda el archivo en disco y
  // añade una entrada BackgroundImage a conversation.metadata.backgroundGallery.
  app.post('/upload-background-image', async (req, reply) => {
    const { conversationId } = req.query as { conversationId?: string };
    if (!conversationId) throw new ValidationError('conversationId es requerido como query param');

    const fileData = await req.file();
    if (!fileData) throw new ValidationError('No se recibió ningún archivo');

    const allowed = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif'];
    if (!allowed.includes(fileData.mimetype)) {
      throw new ValidationError('Tipo de archivo no permitido. Usa JPG, PNG, WebP o GIF.');
    }

    const buffer = await fileData.toBuffer();
    if (buffer.length > 20 * 1024 * 1024) {
      throw new ValidationError('La imagen no puede superar 20 MB.');
    }

    const convRepo = new ConversationRepository();
    const conversation = convRepo.findById(conversationId);
    if (!conversation) throw new NotFoundError('Conversation', conversationId);

    const bgDir = path.join(PROJECT_ROOT, 'data', 'images', 'backgrounds', conversationId);
    fs.mkdirSync(bgDir, { recursive: true });

    const ext = path.extname(fileData.filename).toLowerCase() || '.png';
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2);
    const savedFilename = `bg_upload_${id}${ext}`;
    fs.writeFileSync(path.join(bgDir, savedFilename), buffer);
    const url = `/images/backgrounds/${conversationId}/${savedFilename}`;

    // width/height desconocidos en subidas manuales (informativos; la galería usa CSS).
    const entry: BackgroundImage = { id, url, prompt: '', width: 0, height: 0, createdAt: new Date().toISOString() };

    const meta = (conversation.metadata ?? {}) as Record<string, unknown>;
    const gallery = Array.isArray(meta.backgroundGallery) ? meta.backgroundGallery as BackgroundImage[] : [];
    const updated = convRepo.update(conversationId, { metadata: { ...meta, backgroundGallery: [...gallery, entry] } });

    return reply.send({ success: true, data: updated });
  });

  // DELETE /generate/background-image — removes an image from the gallery (and disk)
  app.delete('/background-image', async (req, reply) => {
    const { conversationId, id } = z.object({
      conversationId: z.string(),
      id:             z.string(),
    }).parse(req.body);

    const convRepo = new ConversationRepository();
    const conversation = convRepo.findById(conversationId);
    if (!conversation) throw new NotFoundError('Conversation', conversationId);

    const meta = (conversation.metadata ?? {}) as Record<string, unknown>;
    const gallery = Array.isArray(meta.backgroundGallery) ? meta.backgroundGallery as BackgroundImage[] : [];
    const entry = gallery.find((g) => g.id === id);
    const remaining = gallery.filter((g) => g.id !== id);

    let background = meta.background as ConversationBackground | undefined;
    if (entry && background?.url === entry.url) background = undefined;

    if (entry) {
      const diskPath = path.join(PROJECT_ROOT, 'data', 'images', entry.url.replace(/^\/images\//, ''));
      if (fs.existsSync(diskPath)) fs.unlinkSync(diskPath);
    }

    const updated = convRepo.update(conversationId, {
      metadata: { ...meta, backgroundGallery: remaining, background },
    });

    return reply.send({ success: true, data: updated });
  });

  // POST /generate/background-active — sets (or clears, with background: null) the active background
  app.post('/background-active', async (req, reply) => {
    const { conversationId, background } = z.object({
      conversationId: z.string(),
      background: z.object({
        url:     z.string(),
        prompt:  z.string().optional(),
        opacity: z.number().min(0).max(1).optional(),
      }).nullable(),
    }).parse(req.body);

    const convRepo = new ConversationRepository();
    const conversation = convRepo.findById(conversationId);
    if (!conversation) throw new NotFoundError('Conversation', conversationId);

    const meta = (conversation.metadata ?? {}) as Record<string, unknown>;
    const updated = convRepo.update(conversationId, {
      metadata: { ...meta, background: background ?? undefined },
    });

    return reply.send({ success: true, data: updated });
  });
};