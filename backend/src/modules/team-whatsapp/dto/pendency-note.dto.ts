import { createZodDto } from 'nestjs-zod';
import {
  pendencyNoteSchema,
  type PendencyNoteInput,
} from '../../../schemas/contracts/team-pendency.schema';

/** K2-7: corpo de `POST pendencies/:id/notes` (Registrar contato). O schema e o tipo vêm do contrato (CK2). */
export { pendencyNoteSchema };
export type { PendencyNoteInput };

export class PendencyNoteDto extends createZodDto(pendencyNoteSchema) {}
