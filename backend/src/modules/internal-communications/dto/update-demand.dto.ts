import { createZodDto } from 'nestjs-zod';
import { updateDemandSchema } from '../../../schemas/contracts/internal-communication.schema';

export class UpdateDemandDto extends createZodDto(updateDemandSchema) {}
