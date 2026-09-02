import { createZodDto } from 'nestjs-zod';
import { updateContactSchema } from '../../../schemas/contracts/contact.schema';

export class UpdateContactDto extends createZodDto(updateContactSchema) {}
