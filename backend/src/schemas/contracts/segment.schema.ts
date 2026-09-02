import { z } from 'zod';
import { filterGroupSchema } from './filter.schema';

export const createSegmentSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  filters: filterGroupSchema,
});

// On update, description accepts null so the UI can CLEAR it (create still uses
// omission for "no description" — null there is meaningless).
export const updateSegmentSchema = createSegmentSchema.partial().extend({
  description: z.string().nullable().optional(),
});

export type CreateSegment = z.infer<typeof createSegmentSchema>;
export type UpdateSegment = z.infer<typeof updateSegmentSchema>;

export type SegmentSummary = {
  id: string;
  name: string;
  description: string | null;
  lastCount: number | null;
  lastCountedAt: Date | null;
  createdAt: Date;
};
