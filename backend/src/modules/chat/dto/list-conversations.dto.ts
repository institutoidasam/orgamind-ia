import { createZodDto } from 'nestjs-zod';
import { listConversationsQuerySchema } from '../../../schemas/contracts/chat.schema';
export class ListConversationsDto extends createZodDto(listConversationsQuerySchema) {}
