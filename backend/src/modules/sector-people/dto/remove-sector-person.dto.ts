import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { removeSectorPersonBodySchema } from '../../../schemas/contracts/sector-people.schema';

/**
 * `DELETE /:userId`: corpo opcional com o motivo (D14). Sem corpo o Express 5
 * deixa `req.body` indefinido, então vira `{}` antes de validar.
 */
export class RemoveSectorPersonDto extends createZodDto(
  z.preprocess((body) => body ?? {}, removeSectorPersonBodySchema),
) {}
