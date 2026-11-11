import { createZodDto } from 'nestjs-zod';
import { listInternalNumbersQuerySchema } from '../../../schemas/contracts/internal-number.schema';

export class ListInternalNumbersDto extends createZodDto(
  listInternalNumbersQuerySchema,
) {}
