import { createZodDto } from 'nestjs-zod';
import { typingSchema } from '../../../schemas/contracts/chat.schema';
export class TypingDto extends createZodDto(typingSchema) {}
