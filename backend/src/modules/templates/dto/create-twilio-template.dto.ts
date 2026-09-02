import { createZodDto } from 'nestjs-zod';
import { createTwilioTemplateSchema } from '../../../schemas/contracts/template.schema';

export class CreateTwilioTemplateDto extends createZodDto(
  createTwilioTemplateSchema,
) {}
