import { createZodDto } from 'nestjs-zod';
import { setOptInLinkActiveSchema } from '../../../schemas/contracts/optin-link.schema';

export class SetOptInLinkActiveDto extends createZodDto(setOptInLinkActiveSchema) {}
