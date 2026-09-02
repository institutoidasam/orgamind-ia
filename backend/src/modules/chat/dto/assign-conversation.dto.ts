import { createZodDto } from 'nestjs-zod';
import { assignConversationSchema } from '../../../schemas/contracts/chat.schema';
export class AssignConversationDto extends createZodDto(assignConversationSchema) {}
