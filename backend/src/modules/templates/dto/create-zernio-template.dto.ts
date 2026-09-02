import { createZodDto } from 'nestjs-zod';
import { createZernioTemplateSchema } from '../../../schemas/contracts/template.schema';

export class CreateZernioTemplateDto extends createZodDto(
  createZernioTemplateSchema,
) {}
