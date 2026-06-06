import { z } from 'zod';

const storyLocationSchema = z.array(
  z.object({
    id: z.string(),
    name: z.string(),
    description: z.string().default(''),
    contents: z.string().default(''),
    exits: z.string().default(''),
    atmosphere: z.string().default(''),
  })
);

const storyEventSchema = z.array(
  z.object({
    id: z.string(),
    title: z.string(),
    description: z.string(),
    trigger: z.string().default(''),
    timestamp: z.string(),
    importance: z.number().int().min(1).max(10).default(5),
  })
);

const timelineSchema = z.array(
  z.object({
    id: z.string(),
    label: z.string(),
    description: z.string(),
    order: z.number().int(),
  })
);

const storyCharacterLinkSchema = z.array(
  z.object({
    characterId: z.string(),
    role: z.string().default(''),
    notes: z.string().default(''),
  })
);

export const createStorySchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(2000).default(''),
  globalContext: z.string().max(8000).default(''),
  narrativeRules: z.string().max(4000).default(''),
  worldLore: z.string().max(8000).default(''),
  persistentEvents: storyEventSchema.default([]),
  locations: storyLocationSchema.default([]),
  stateVariables: z.record(z.union([z.string(), z.number(), z.boolean()])).default({}),
  timeline: timelineSchema.default([]),
  behaviorRestrictions: z.array(z.string()).default([]),
  isActive: z.boolean().default(false),
  adventureMode: z.boolean().default(false),
  characters: storyCharacterLinkSchema.default([]),
});

export const updateStorySchema = createStorySchema.partial();

export type CreateStoryInput = z.infer<typeof createStorySchema>;
export type UpdateStoryInput = z.infer<typeof updateStorySchema>;
