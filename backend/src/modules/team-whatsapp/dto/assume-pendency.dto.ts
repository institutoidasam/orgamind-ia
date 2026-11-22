import { createZodDto } from 'nestjs-zod';
import {
  assumePendencySchema,
  type AssumePendencyInput,
} from '../../../schemas/contracts/team-pendency.schema';

/** K2-7: corpo de `POST pendencies/:id/assume`. O schema e o tipo vêm do contrato (CK2). */
export { assumePendencySchema };
export type { AssumePendencyInput };

export class AssumePendencyDto extends createZodDto(assumePendencySchema) {}
