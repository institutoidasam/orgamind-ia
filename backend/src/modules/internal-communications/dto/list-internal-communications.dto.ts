import { createZodDto } from 'nestjs-zod';
import { internalCommunicationListQuerySchema } from '../../../schemas/contracts/internal-communication.schema';

export class ListInternalCommunicationsDto extends createZodDto(
  internalCommunicationListQuerySchema,
) {}
