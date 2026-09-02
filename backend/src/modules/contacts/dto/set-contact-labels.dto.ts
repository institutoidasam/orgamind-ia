import { createZodDto } from 'nestjs-zod';
import { setContactLabelsSchema } from '../../../schemas/contracts/contact.schema';

export class SetContactLabelsDto extends createZodDto(setContactLabelsSchema) {}
