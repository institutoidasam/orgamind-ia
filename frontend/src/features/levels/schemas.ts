import { z } from 'zod';

/**
 * Espelho à mão do contrato do back (`backend/src/schemas/contracts/level.schema.ts`).
 * O back é a fonte: mudou lá, muda aqui no mesmo PR.
 */

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

export const levelListSchema = z.object({ items: levelAdminSchema.array() });

export type LevelRef = z.infer<typeof levelRefSchema>;
export type LevelAdmin = z.infer<typeof levelAdminSchema>;

export type CreateLevelInput = Pick<LevelRef, 'name'>;
export type UpdateLevelInput = Partial<CreateLevelInput & { isActive: boolean }>;

/** Formulário do nível: só o nome. */
export const levelFormSchema = z.object({
  name: z.string().trim().min(1, 'Informe o nome').max(40, 'Use até 40 caracteres'),
});
