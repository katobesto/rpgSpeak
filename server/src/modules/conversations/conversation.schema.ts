import { z } from 'zod';

export const createConversationSchema = z.object({
  title: z.string().max(200).optional(),
  mode: z.enum(['single', 'group', 'story']).default('single'),
  characterIds: z.array(z.string()).default([]),
  storyIds: z.array(z.string()).default([]),
});

export const updateConversationSchema = z.object({
  title: z.string().max(200).optional(),
  activeCharacterId: z.string().nullable().optional(),
  isArchived: z.boolean().optional(),
  summary: z.string().nullable().optional(),
  characterIds: z.array(z.string()).optional(),
  storyIds: z.array(z.string()).optional(),
});

export const partyStateSchema = z.object({
  members: z.array(z.object({
    id: z.string(),
    name: z.string(),
    hp: z.number(),
    maxHp: z.number(),
    energy: z.number(),
    maxEnergy: z.number(),
  })),
  inventory: z.array(z.object({
    id: z.string(),
    name: z.string(),
    quantity: z.number(),
  })),
  xp: z.number(),
  gold: z.number(),
  updatedAt: z.string(),
});

// Misma forma que RpgStats (ver shared/types) — la ficha del jugador para ESTA
// conversación. `hp` aquí es solo el punto de partida: el HP en vivo sigue
// siendo partyState, igual que ya ocurre con los personajes del grupo.
export const playerSheetSchema = z.object({
  class: z.string().max(60).optional(),
  level: z.number().int().min(1).max(20).optional(),
  hp: z.number().optional(),
  maxHp: z.number().optional(),
  stats: z.record(z.string(), z.number()).optional(),
  abilities: z.array(z.string().max(100)).max(30).optional(),
  inventory: z.array(z.string().max(150)).max(50).optional(),
  notes: z.string().max(1000).optional(),
});

export type CreateConversationInput = z.infer<typeof createConversationSchema>;
export type UpdateConversationInput = z.infer<typeof updateConversationSchema>;
