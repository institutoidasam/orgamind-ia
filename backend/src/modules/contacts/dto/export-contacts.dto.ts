import { createZodDto } from 'nestjs-zod';
import { exportContactsQuerySchema } from '../../../schemas/contracts/contact.schema';

export class ExportContactsDto extends createZodDto(
  exportContactsQuerySchema,
) {}
