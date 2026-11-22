import { createZodDto } from 'nestjs-zod';
import { pendencyHandoverSchema } from '../../../schemas/contracts/team-pendency.schema';

/** K3-4: corpo de `POST pendency-handover`. O schema e o tipo (`PendencyHandoverInput`) vêm do contrato (CT2). */
export class PendencyHandoverDto extends createZodDto(pendencyHandoverSchema) {}
