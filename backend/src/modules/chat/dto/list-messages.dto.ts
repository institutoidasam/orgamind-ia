import { createZodDto } from 'nestjs-zod';
import { listMessagesQuerySchema } from '../../../schemas/contracts/chat.schema';
export class ListMessagesDto extends createZodDto(listMessagesQuerySchema) {}
