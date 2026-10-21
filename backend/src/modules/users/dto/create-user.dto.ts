import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { workShiftSchema } from '../../../schemas/contracts/user.schema';

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
  // Turno fixo; ausente ou null = sem turno.
  shift: workShiftSchema.nullable().optional(),
});

export class CreateUserDto extends createZodDto(createUserSchema) {}
