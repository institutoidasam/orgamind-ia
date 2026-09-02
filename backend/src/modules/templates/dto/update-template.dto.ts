import { createZodDto } from 'nestjs-zod';
import { updateTemplateSchema } from '../../../schemas/contracts/template.schema';

export class UpdateTemplateDto extends createZodDto(updateTemplateSchema) {}
