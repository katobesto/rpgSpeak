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
    location: z.string().default(''),
    timestamp: z.string(),
    importance: z.number().int().min(1).max(10).default(5),
  })
);

const storyCharacterLinkSchema = z.array(
  z.object({
    characterId: z.string(),
    role: z.string().default(''),
    notes: z.string().default(''),
  })
);

// Calendario del mundo. Los mínimos protegen la aritmética del reloj: sin meses
// no hay fecha posible, y un ciclo lunar de 0 días dividiría por cero.
const storyCalendarSchema = z.object({
  name: z.string().default(''),
  months: z.array(z.string()).min(1),
  daysPerMonth: z.array(z.number().int().min(1).max(400)).min(1),
  weekdays: z.array(z.string()).min(1),
  seasons: z.array(z.string()).default([]),
  moonCycleDays: z.number().int().min(1).max(400).default(28),
  startYear: z.number().int().default(1),
  startMonth: z.number().int().min(0).default(0),
  startDay: z.number().int().min(1).default(1),
  startMinuteOfDay: z.number().int().min(0).max(1439).default(480),
  startWeekdayIndex: z.number().int().min(0).default(0),
  startMoonDay: z.number().int().min(0).default(0),
});

export const createStorySchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(2000).default(''),
  globalContext: z.string().max(8000).default(''),
  narrativeRules: z.string().max(4000).default(''),
  worldLore: z.string().max(8000).default(''),
  persistentEvents: storyEventSchema.default([]),
  locations: storyLocationSchema.default([]),
  stateVariables: z.record(z.union([z.string(), z.number(), z.boolean()])).default({}),
  behaviorRestrictions: z.array(z.string()).default([]),
  isActive: z.boolean().default(false),
  adventureMode: z.boolean().default(false),
  openWorld: z.boolean().default(false),
  deathMode: z.boolean().default(false),
  calendar: storyCalendarSchema.nullable().default(null),
  characters: storyCharacterLinkSchema.default([]),
});

export const updateStorySchema = createStorySchema.partial();

export type CreateStoryInput = z.infer<typeof createStorySchema>;
export type UpdateStoryInput = z.infer<typeof updateStorySchema>;
