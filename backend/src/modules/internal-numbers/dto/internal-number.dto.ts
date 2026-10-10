import { createZodDto } from 'nestjs-zod';
import {
  createInternalNumberSchema,
  listInternalNumbersQuerySchema,
  updateInternalNumberSchema,
} from '../../../schemas/contracts/internal-number.schema';

export class CreateInternalNumberDto extends createZodDto(
  createInternalNumberSchema,
) {}
export class UpdateInternalNumberDto extends createZodDto(
  updateInternalNumberSchema,
) {}
export class ListInternalNumbersDto extends createZodDto(
  listInternalNumbersQuerySchema,
) {}
