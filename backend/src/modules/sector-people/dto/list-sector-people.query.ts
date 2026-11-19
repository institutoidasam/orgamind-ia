import { createZodDto } from 'nestjs-zod';
import { sectorPeopleListQuerySchema } from '../../../schemas/contracts/sector-people.schema';

/** `?includeInactive=true` de `GET /people`: sem o parâmetro só vêm os ativos (A3). */
export class ListSectorPeopleQueryDto extends createZodDto(
  sectorPeopleListQuerySchema,
) {}
