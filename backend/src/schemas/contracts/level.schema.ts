import { z } from 'zod';

const levelNameSchema = z.string().trim().min(1).max(40);

export const levelRefSchema = z.object({
  id: z.string(),
  name: z.string(),
});

/** `userCount` = pessoas com o nível (ativas ou não); nível não se apaga. */
export const levelAdminSchema = levelRefSchema.extend({
  isActive: z.boolean(),
  sortOrder: z.number().int(),
  userCount: z.number().int().nonnegative(),
});

export const levelListResponseSchema = z.object({
  items: levelAdminSchema.array(),
});

export const createLevelSchema = z.object({
  name: levelNameSchema,
});

export const updateLevelSchema = z
  .object({
    name: levelNameSchema.optional(),
    isActive: z.boolean().optional(),
  })
  .refine(
    ({ name, isActive }) => name !== undefined || isActive !== undefined,
    'Informe ao menos um campo',
  );

export const reorderLevelsSchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(100),
});

export type LevelRef = z.infer<typeof levelRefSchema>;
export type LevelAdmin = z.infer<typeof levelAdminSchema>;
export type LevelListResponse = z.infer<typeof levelListResponseSchema>;
export type CreateLevelInput = z.infer<typeof createLevelSchema>;
export type UpdateLevelInput = z.infer<typeof updateLevelSchema>;
export type ReorderLevelsInput = z.infer<typeof reorderLevelsSchema>;
