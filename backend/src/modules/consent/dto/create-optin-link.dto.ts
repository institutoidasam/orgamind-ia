import { createZodDto } from 'nestjs-zod';
import { createOptInLinkSchema } from '../../../schemas/contracts/optin-link.schema';

export class CreateOptInLinkDto extends createZodDto(createOptInLinkSchema) {}
