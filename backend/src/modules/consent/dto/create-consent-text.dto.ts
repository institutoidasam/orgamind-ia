import { createZodDto } from 'nestjs-zod';
import { createConsentTextSchema } from '../../../schemas/contracts/consent-admin.schema';

export class CreateConsentTextDto extends createZodDto(createConsentTextSchema) {}
