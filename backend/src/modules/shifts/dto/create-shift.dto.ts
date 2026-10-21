import { createZodDto } from 'nestjs-zod';
import { createShiftSchema } from '../../../schemas/contracts/shift.schema';

export class CreateShiftDto extends createZodDto(createShiftSchema) {}
