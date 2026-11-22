import { createZodDto } from 'nestjs-zod';
import { scheduleExportQuerySchema } from '../../../schemas/contracts/people-export.schema';

/** `GET /schedule`: `format`, setor e período são obrigatórios (D2). */
export class ScheduleExportQueryDto extends createZodDto(
  scheduleExportQuerySchema,
) {}
