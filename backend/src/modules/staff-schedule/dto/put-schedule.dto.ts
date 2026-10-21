import { createZodDto } from 'nestjs-zod';
import { putScheduleSchema } from '../../../schemas/contracts/staff-schedule.schema';

/** Ciclo da pessoa (C5): `days.length === cycleLength`, turnos checados no serviço. */
export class PutScheduleDto extends createZodDto(putScheduleSchema) {}
