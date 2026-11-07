import { z } from 'zod';

const rpgStatsSchema = z.object({
  class: z.string().optional(),
  level: z.number().int().min(1).max(20).optional(),
  hp: z.number().optional(),
  maxHp: z.number().optional(),
  stats: z.record(z.number()).optional(),
  abilities: z.array(z.string()).optional(),
  inventory: z.array(z.string()).optional(),
  notes: z.string().optional(),
}).default({});

const llmParamsSchema = z.object({
  topP: z.number().min(0).max(1).optional(),
  topK: z.number().int().min(0).optional(),
  repetitionPenalty: z.number().min(0.01).max(2).optional(),
  frequencyPenalty: z.number().min(-2).max(2).optional(),
  presencePenalty: z.number().min(-2).max(2).optional(),
  maxTokens: z.number().int().positive().optional(),
  stopSequences: z.array(z.string()).optional(),
  seed: z.number().int().optional(),
}).passthrough();

const exampleDialogueSchema = z.array(
  z.object({ user: z.string(), assistant: z.string() })
);

const characterRelationSchema = z.array(
  z.object({
    characterId: z.string(),
    relationshipType: z.string(),
    description: z.string(),
  })
);

export const createCharacterSchema = z.object({
  name: z.string().min(1).max(100),
  avatar: z.string().nullable().optional(),
  description: z.string().max(2000).default(''),
  personality: z.string().max(4000).default(''),
  systemPrompt: z.string().max(8000).default(''),
  lore: z.string().max(8000).default(''),
  exampleDialogue: exampleDialogueSchema.default([]),
  tags: z.array(z.string().max(50)).max(20).default([]),
  temperature: z.number().min(0).max(2).default(0.8),
  modelId: z.string().nullable().optional(),
  providerId: z.string().nullable().optional(),
  contextLength: z.number().int().min(512).max(131072).default(4096),
  memoryEnabled: z.boolean().default(true),
  memoryType: z.enum(['rolling', 'summary', 'none']).default('rolling'),
  memoryWindow: z.number().int().min(1).max(200).default(20),
  llmParams: llmParamsSchema.default({}),
  relations: characterRelationSchema.default([]),
  rpgStats: rpgStatsSchema,
  imageDescription: z.string().nullable().optional(),
  gallery: z.array(z.string()).default([]),
});

export const updateCharacterSchema = createCharacterSchema.partial();

export type CreateCharacterInput = z.infer<typeof createCharacterSchema>;
export type UpdateCharacterInput = z.infer<typeof updateCharacterSchema>;
