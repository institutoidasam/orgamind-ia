import { createZodDto } from 'nestjs-zod';
import { pendencyHandoverTargetsQuerySchema } from '../../../schemas/contracts/team-pendency.schema';

/** K3-4/K2-7: `GET pendency-handover/targets?fromUserId=`. O schema vem do contrato (CT2). */
export class PendencyHandoverTargetsQueryDto extends createZodDto(
  pendencyHandoverTargetsQuerySchema,
) {}
