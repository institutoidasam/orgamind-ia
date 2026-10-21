import { createZodDto } from 'nestjs-zod';
import { boardQuerySchema } from '../../../schemas/contracts/staff-schedule.schema';

export class BoardQueryDto extends createZodDto(boardQuerySchema) {}
