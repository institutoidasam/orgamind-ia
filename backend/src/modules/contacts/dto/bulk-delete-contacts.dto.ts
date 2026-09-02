import { createZodDto } from 'nestjs-zod';
import { bulkDeleteContactsSchema } from '../../../schemas/contracts/contact.schema';

export class BulkDeleteContactsDto extends createZodDto(
  bulkDeleteContactsSchema,
) {}
