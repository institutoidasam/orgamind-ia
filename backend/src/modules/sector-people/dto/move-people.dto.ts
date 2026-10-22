import { createZodDto } from 'nestjs-zod';
import { movePeopleBodySchema } from '../../../schemas/contracts/sector-people.schema';

/** `POST /move`: 1..100 pessoas já cadastradas que vêm para o setor. */
export class MovePeopleDto extends createZodDto(movePeopleBodySchema) {}
