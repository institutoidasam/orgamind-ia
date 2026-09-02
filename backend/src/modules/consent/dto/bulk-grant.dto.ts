import { createZodDto } from 'nestjs-zod';
import { bulkGrantWithPastDateSchema } from '../../../schemas/contracts/consent-admin.schema';

export class BulkGrantDto extends createZodDto(bulkGrantWithPastDateSchema) {}
