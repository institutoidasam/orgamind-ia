import { createZodDto } from 'nestjs-zod';
import { createInternalCommentSchema } from '../../../schemas/contracts/internal-communication.schema';

export class CreateInternalCommentDto extends createZodDto(
  createInternalCommentSchema,
) {}
