import { z } from "zod";
import {
  filterGroupSchema,
  type FilterGroup,
} from "@/features/campaigns/schemas";

export type { FilterGroup, Rule } from "@/features/campaigns/schemas";

export const createSegmentSchema = z.object({
  name: z.string().min(1, "Informe um nome"),
  description: z.string().optional(),
  filters: filterGroupSchema,
});
export type CreateSegment = z.infer<typeof createSegmentSchema>;

export const updateSegmentSchema = createSegmentSchema.partial();
export type UpdateSegment = z.infer<typeof updateSegmentSchema>;

export type SegmentSummary = {
  id: string;
  name: string;
  description: string | null;
  lastCount: number | null;
  lastCountedAt: string | Date | null;
  createdAt: string | Date;
};

export type SegmentDetail = SegmentSummary & {
  filters: FilterGroup;
  createdById: string | null;
  updatedAt: string | Date;
};

export type SegmentPreviewResult = {
  count: number;
  sample: { id: string; name: string | null; phoneE164: string }[];
};

export type SegmentPreflightResult = {
  total: number;
  reachable: number;
  invalid: number;
  unknown: number;
};
