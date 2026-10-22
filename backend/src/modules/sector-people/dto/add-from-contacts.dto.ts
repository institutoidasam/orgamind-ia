import { createZodDto } from 'nestjs-zod';
import { addFromContactsBodySchema } from '../../../schemas/contracts/sector-people.schema';

/** `POST /from-contacts`: 1..100 contatos, um nível opcional e um turno (Q3). */
export class AddFromContactsDto extends createZodDto(
  addFromContactsBodySchema,
) {}
