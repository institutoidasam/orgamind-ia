import { createZodDto } from 'nestjs-zod';
import { sectorPersonStatusBodySchema } from '../../../schemas/contracts/sector-people.schema';

/** `POST /:userId/status`: `{ isActive, reason }`; o motivo é cobrado pelo serviço (A3). */
export class SetSectorPersonStatusDto extends createZodDto(
  sectorPersonStatusBodySchema,
) {}
