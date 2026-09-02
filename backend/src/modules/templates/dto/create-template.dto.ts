import { createZodDto } from 'nestjs-zod';
import { createTemplateSchema } from '../../../schemas/contracts/template.schema';

export class CreateTemplateDto extends createZodDto(createTemplateSchema) {}
