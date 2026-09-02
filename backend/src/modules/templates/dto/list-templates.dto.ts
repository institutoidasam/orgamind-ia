import { createZodDto } from 'nestjs-zod';
import { listTemplatesQuerySchema } from '../../../schemas/contracts/template.schema';

export class ListTemplatesDto extends createZodDto(listTemplatesQuerySchema) {}
