import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const assignBotSchema = z.object({
  instanceId: z.string().cuid(),
  difyAppId: z.string().min(1).nullable(),
});

export class AssignBotDto extends createZodDto(assignBotSchema) {}
