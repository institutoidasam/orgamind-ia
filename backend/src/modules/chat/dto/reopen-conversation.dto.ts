import { createZodDto } from 'nestjs-zod';
import { reopenConversationSchema } from '../../../schemas/contracts/chat.schema';
export class ReopenConversationDto extends createZodDto(
  reopenConversationSchema,
) {}
