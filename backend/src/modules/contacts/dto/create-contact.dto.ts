import { createZodDto } from 'nestjs-zod';
import { createContactSchema } from '../../../schemas/contracts/contact.schema';

export class CreateContactDto extends createZodDto(createContactSchema) {}
