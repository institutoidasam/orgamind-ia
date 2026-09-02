import { createZodDto } from 'nestjs-zod';
import { sendReplySchema } from '../../../schemas/contracts/chat.schema';
export class SendReplyDto extends createZodDto(sendReplySchema) {}
