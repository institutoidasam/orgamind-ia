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
  // O front envia `sectorId: null` para ADMIN "Sem setor". Normaliza para
  // undefined: o UsersService só conhece `string | undefined` e a regra
  // "não-ADMIN exige setor" continua valendo (null → undefined → erro).
  sectorId: z
    .string()
    .nullable()
    .optional()
    .transform((value) => value ?? undefined),
  // WhatsApp do usuário: obrigatório no convite. Só apara aqui; a normalização
  // para E.164 (e o erro user.invalid_phone) é do UserPhoneService.
  phone: z.string().trim().min(1).max(40),
  // Turno do cadastro (id de Shift); ausente ou null = sem turno. Inexistente ou
  // inativo = 422 users.invalid_shift (UsersService).
  shiftId: z.string().min(1).nullable().optional(),
  // Função (texto livre). Apara e limita a 80; vazio ou null = sem função.
  jobTitle: z.string().trim().max(80).nullable().optional(),
});

export class CreateUserDto extends createZodDto(createUserSchema) {}
