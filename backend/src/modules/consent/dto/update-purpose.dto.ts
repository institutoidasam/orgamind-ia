import { createZodDto } from 'nestjs-zod';
import { updatePurposeSchema } from '../../../schemas/contracts/consent-admin.schema';

export class UpdatePurposeDto extends createZodDto(updatePurposeSchema) {}
