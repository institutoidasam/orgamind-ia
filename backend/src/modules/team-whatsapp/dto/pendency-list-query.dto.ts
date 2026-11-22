import { createZodDto } from 'nestjs-zod';
import {
  pendencyListQuerySchema,
  type PendencyListQuery,
} from '../../../schemas/contracts/team-pendency.schema';

/** K2-5: `GET pendencies?situations&sectorId&mine&days&page&pageSize`. O schema e o tipo vêm do contrato (CK2). */
export { pendencyListQuerySchema };
export type { PendencyListQuery };

export class PendencyListQueryDto extends createZodDto(
  pendencyListQuerySchema,
) {}
