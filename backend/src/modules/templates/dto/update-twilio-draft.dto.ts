import { createZodDto } from 'nestjs-zod';
import { updateTwilioDraftSchema } from '../../../schemas/contracts/template.schema';

export class UpdateTwilioDraftDto extends createZodDto(
  updateTwilioDraftSchema,
) {}
