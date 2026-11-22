import { createZodDto } from 'nestjs-zod';
import { rowsQuerySchema } from '../../../schemas/contracts/people-import.schema';

/** `GET batches/:id/rows`: página (a partir de 1) e classificação opcional. */
export class RowsQueryDto extends createZodDto(rowsQuerySchema) {}
