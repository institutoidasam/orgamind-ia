import { createZodDto } from 'nestjs-zod';
import { listContactsQuerySchema } from '../../../schemas/contracts/contact.schema';

export class ListContactsDto extends createZodDto(listContactsQuerySchema) {}
