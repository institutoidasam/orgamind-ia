import { createZodDto } from 'nestjs-zod';
import { shiftHandoverSchema } from '../../../schemas/contracts/chat.schema';

/** K3-1: corpo de `POST chat/handover`. O schema e o tipo vêm do contrato (CT1). */
export class ShiftHandoverDto extends createZodDto(shiftHandoverSchema) {}
