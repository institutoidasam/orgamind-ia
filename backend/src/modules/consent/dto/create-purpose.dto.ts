import { createZodDto } from 'nestjs-zod';
import { createPurposeSchema } from '../../../schemas/contracts/consent-admin.schema';

export class CreatePurposeDto extends createZodDto(createPurposeSchema) {}
