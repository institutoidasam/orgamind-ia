import { z } from 'zod';

// App do Dify (vem da console API; `id` -> difyAppId).
export const difyAppSchema = z.object({
  id: z.string(),
  name: z.string(),
  mode: z.string(),
}).transform((a) => ({ difyAppId: a.id, name: a.name, mode: a.mode }));
export type DifyApp = z.infer<typeof difyAppSchema>;

export const assignBotInputSchema = z.object({
  instanceId: z.string(),
  difyAppId: z.string().nullable(),
});
export type AssignBotInput = z.infer<typeof assignBotInputSchema>;
