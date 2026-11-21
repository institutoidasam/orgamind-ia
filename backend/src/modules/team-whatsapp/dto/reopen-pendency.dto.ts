import { createZodDto } from 'nestjs-zod';
import {
  reopenPendencySchema,
  type ReopenPendencyInput,
} from '../../../schemas/contracts/team-pendency.schema';

/** K2-7: corpo de `POST pendencies/:id/reopen`. O schema e o tipo vêm do contrato (CK2). */
export { reopenPendencySchema };
export type { ReopenPendencyInput };

export class ReopenPendencyDto extends createZodDto(reopenPendencySchema) {}
