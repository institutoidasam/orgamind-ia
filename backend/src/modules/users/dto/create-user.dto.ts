import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const createUserSchema = z.object({
  // Trim + lowercase BEFORE validating (then pipe into z.email()). Normalizing
  // at this boundary stops `Foo@Bar.com` and `foo@bar.com` from creating two
  // distinct rows in the case-sensitive `email String @unique` Postgres column.
  email: z.string().trim().toLowerCase().pipe(z.email()),
  name: z.string().max(120).optional(),
  role: z
    .enum(['ADMIN', 'OPERATOR', 'SUPERVISOR', 'VIEWER'])
    .default('OPERATOR'),
  sectorId: z.string().optional(),
  // WhatsApp do usuário: obrigatório no convite. Só apara aqui; a normalização
  // para E.164 (e o erro user.invalid_phone) é do UserPhoneService.
  phone: z.string().trim().min(1).max(40),
});

export class CreateUserDto extends createZodDto(createUserSchema) {}
