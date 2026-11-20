import { createZodDto } from 'nestjs-zod';
import { templateQuerySchema } from '../../../schemas/contracts/people-import.schema';

/** `GET template`: `format` obrigatório, `csv` ou `xlsx`. */
export class TemplateQueryDto extends createZodDto(templateQuerySchema) {}
