import { createZodDto } from 'nestjs-zod';
import { confirmBodySchema } from '../../../schemas/contracts/people-import.schema';

/** `POST batches/:id/confirm`: o que gravar e as linhas tiradas da seleção (EX7). */
export class ConfirmBodyDto extends createZodDto(confirmBodySchema) {}
