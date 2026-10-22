import { createZodDto } from 'nestjs-zod';
import { createSectorPersonBodySchema } from '../../../schemas/contracts/sector-people.schema';

/** `POST /`: pessoa sem acesso neste setor; turno obrigatório (Q3). */
export class CreateSectorPersonDto extends createZodDto(
  createSectorPersonBodySchema,
) {}
