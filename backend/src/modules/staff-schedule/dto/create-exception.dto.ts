import { createZodDto } from 'nestjs-zod';
import { createStaffExceptionSchema } from '../../../schemas/contracts/staff-schedule.schema';

/** Exceção por data (C5): até 366 dias; campos exigidos/proibidos por `kind`. */
export class CreateExceptionDto extends createZodDto(
  createStaffExceptionSchema,
) {}
