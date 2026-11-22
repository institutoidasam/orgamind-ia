import { z } from 'zod';
import { contactAuthorizationInputSchema } from '../../../schemas/contracts/contact-authorization.schema';

// WhatsApp: obrigatório nos dois cadastros. Só apara aqui; a normalização para
// E.164 (e o erro user.invalid_phone) é do UserPhoneService.
const phoneSchema = z.string().trim().min(1).max(40);
// Turno do cadastro (id de Shift); ausente ou null = sem turno. Inexistente ou
// inativo = 422 users.invalid_shift (UsersService).
const shiftIdSchema = z.string().min(1).nullable().optional();
// Função (texto livre). Apara e limita a 80; vazio ou null = sem função.
const jobTitleSchema = z.string().trim().max(80).nullable().optional();
// Nível (id de StaffLevel); ausente ou null = sem nível. Inexistente ou
// inativo = 422 users.invalid_level (UsersService).
const levelIdSchema = z.string().min(1).nullable().optional();
// Ficha (C5): matrícula opcional, aparada, até 30 (a unicidade é do UsersService);
// autorização sem o campo = NAO_AUTORIZADO, e CADASTRO_ANTERIOR não é aceito (400).
const registrationSchema = z.string().trim().max(30).nullable().optional();
const contactAuthorizationSchema = contactAuthorizationInputSchema.optional();

// Convite (com acesso, `hasAccess` ausente ou true): o fluxo de hoje.
const inviteSchema = z.object({
  hasAccess: z.literal(true).optional(),
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
  phone: phoneSchema,
  shiftId: shiftIdSchema,
  jobTitle: jobTitleSchema,
  levelId: levelIdSchema,
  registration: registrationSchema,
  contactAuthorization: contactAuthorizationSchema,
});

// Pessoa sem acesso (C2, D1): nome e telefone obrigatórios, setor opcional;
// e-mail e papel proibidos (400) — o papel gravado é sempre VIEWER e a
// credencial só nasce por POST /users/:id/access.
const personWithoutAccessSchema = z.object({
  hasAccess: z.literal(false),
  name: z.string().trim().min(1).max(120),
  phone: phoneSchema,
  // Ausente ou null = sem setor (o serviço recebe sempre string | null).
  sectorId: z
    .string()
    .min(1)
    .nullable()
    .optional()
    .transform((value) => value ?? null),
  levelId: levelIdSchema,
  shiftId: shiftIdSchema,
  jobTitle: jobTitleSchema,
  registration: registrationSchema,
  contactAuthorization: contactAuthorizationSchema,
  email: z.never().optional(),
  role: z.never().optional(),
});

/**
 * POST /users. União (não classe): `createZodDto` de uma união não vira classe
 * no TS, então o controller valida com `ZodValidationPipe(createUserSchema)`.
 */
export const createUserSchema = z.union([
  personWithoutAccessSchema,
  inviteSchema,
]);

export type CreateUserBody = z.output<typeof createUserSchema>;
