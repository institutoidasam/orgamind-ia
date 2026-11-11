import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { channelSectorIdsSchema } from '../../../schemas/contracts/instance.schema';

export const createInstanceSchema = z.object({
  name: z.string().min(2).max(80),
  ownerUserId: z.string().cuid().nullable().optional(),
  isDefault: z.boolean().optional(),
  // Áreas que o número atende; validadas antes de criar a instância na Evolution.
  sectorIds: channelSectorIdsSchema.optional(),
});

export class CreateInstanceDto extends createZodDto(createInstanceSchema) {}
