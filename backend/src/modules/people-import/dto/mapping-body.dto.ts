import { createZodDto } from 'nestjs-zod';
import { mappingBodySchema } from '../../../schemas/contracts/people-import.schema';

/** `PUT batches/:id/mapping`: as 11 chaves, índice da coluna ou `null`, sem índice repetido (E3). */
export class MappingBodyDto extends createZodDto(mappingBodySchema) {}
