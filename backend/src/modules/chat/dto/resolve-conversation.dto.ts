import { createZodDto } from 'nestjs-zod';
import { resolveConversationSchema } from '../../../schemas/contracts/chat.schema';
export class ResolveConversationDto extends createZodDto(
  resolveConversationSchema,
) {}
