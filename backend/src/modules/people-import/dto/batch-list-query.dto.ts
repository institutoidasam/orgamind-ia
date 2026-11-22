import { createZodDto } from 'nestjs-zod';
import { batchListQuerySchema } from '../../../schemas/contracts/people-import.schema';

/** `GET batches`: página (a partir de 1). */
export class BatchListQueryDto extends createZodDto(batchListQuerySchema) {}
