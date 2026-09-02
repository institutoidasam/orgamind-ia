import { createZodDto } from 'nestjs-zod';
import { loginInputSchema } from '../../../schemas/contracts/auth.schema';

export class LoginDto extends createZodDto(loginInputSchema) {}
