import { createZodDto } from 'nestjs-zod';
import {
  transferPendencySchema,
  type TransferPendencyInput,
} from '../../../schemas/contracts/team-pendency.schema';

/** K2-7: corpo de `POST pendencies/:id/transfer`. O schema e o tipo vêm do contrato (CK2). */
export { transferPendencySchema };
export type { TransferPendencyInput };

export class TransferPendencyDto extends createZodDto(transferPendencySchema) {}
