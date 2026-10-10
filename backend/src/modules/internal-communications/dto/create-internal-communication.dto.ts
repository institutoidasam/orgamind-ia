import { createZodDto } from 'nestjs-zod';
import { createInternalCommunicationSchema } from '../../../schemas/contracts/internal-communication.schema';

export class CreateInternalCommunicationDto extends createZodDto(
  createInternalCommunicationSchema,
) {}
