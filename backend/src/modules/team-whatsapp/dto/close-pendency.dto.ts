import { createZodDto } from 'nestjs-zod';
import {
  closePendencySchema,
  type ClosePendencyInput,
} from '../../../schemas/contracts/team-pendency.schema';

/** K2-7: corpo de `POST pendencies/:id/close`. O schema e o tipo vêm do contrato (CK2). */
export { closePendencySchema };
export type { ClosePendencyInput };

export class ClosePendencyDto extends createZodDto(closePendencySchema) {}
