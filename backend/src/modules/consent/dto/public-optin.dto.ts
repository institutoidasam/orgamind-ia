import { createZodDto } from 'nestjs-zod';
import { publicOptInSchema } from '../../../schemas/contracts/public-optin.schema';

export class PublicOptInDto extends createZodDto(publicOptInSchema) {}
