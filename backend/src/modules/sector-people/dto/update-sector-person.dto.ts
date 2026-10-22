import { createZodDto } from 'nestjs-zod';
import { updateSectorPersonBodySchema } from '../../../schemas/contracts/sector-people.schema';

/** `PATCH /:userId`: ao menos um campo; com acesso, só nível, função e turno. */
export class UpdateSectorPersonDto extends createZodDto(
  updateSectorPersonBodySchema,
) {}
