import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const createUserSchema = z.object({
  // Trim + lowercase BEFORE validating (then pipe into z.email()). Normalizing
  // at this boundary stops `Foo@Bar.com` and `foo@bar.com` from creating two
  // distinct rows in the case-sensitive `email String @unique` Postgres column.
  email: z.string().trim().toLowerCase().pipe(z.email()),
  name: z.string().max(120).optional(),
  role: z.enum(['ADMIN', 'OPERATOR']).default('OPERATOR'),
});

export class CreateUserDto extends createZodDto(createUserSchema) {}
