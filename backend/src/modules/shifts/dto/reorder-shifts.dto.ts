import { createZodDto } from 'nestjs-zod';
import { reorderShiftsSchema } from '../../../schemas/contracts/shift.schema';

/** Todos os turnos, cada um uma vez, na ordem desejada (1..100 ids). */
export class ReorderShiftsDto extends createZodDto(reorderShiftsSchema) {}
