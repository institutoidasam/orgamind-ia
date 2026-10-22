import { createZodDto } from 'nestjs-zod';
import { sectorPeopleSearchQuerySchema } from '../../../schemas/contracts/sector-people.schema';

/** `?q=` de `candidates` e `contact-candidates` (trim, até 80). */
export class ListCandidatesQueryDto extends createZodDto(
  sectorPeopleSearchQuerySchema,
) {}
