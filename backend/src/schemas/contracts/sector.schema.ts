import { z } from 'zod';

const code = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9]{1,8}$/);
const strictBoolean = z
  .union([z.boolean(), z.enum(['true', 'false'])])
  .transform((value) => value === true || value === 'true');

export const sectorInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  code,
  description: z.string().trim().max(500).nullable().optional(),
  managerId: z.string().nullable().optional(),
  isActive: z.boolean().optional(),
});
export const createSectorSchema = sectorInputSchema.extend({
  isActive: z.boolean().optional(),
});
export const updateSectorSchema = sectorInputSchema
  .partial()
  .refine(
    (value) => Object.keys(value).length > 0,
    'At least one field is required',
  );
export const listSectorsQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  activeOnly: strictBoolean.optional(),
});
export const membersQuerySchema = z.object({
  eligible: strictBoolean.optional(),
});
export type CreateSector = z.infer<typeof createSectorSchema>;
export type UpdateSector = z.infer<typeof updateSectorSchema>;
