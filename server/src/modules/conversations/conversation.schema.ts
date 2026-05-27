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

export type CreateConversationInput = z.infer<typeof createConversationSchema>;
export type UpdateConversationInput = z.infer<typeof updateConversationSchema>;
