import { createZodDto } from 'nestjs-zod';
import { peopleExportQuerySchema } from '../../../schemas/contracts/people-export.schema';

/** `GET /people`: `format` obrigatório; setor, turno, situação e data são filtros (D1). */
export class PeopleExportQueryDto extends createZodDto(
  peopleExportQuerySchema,
) {}
