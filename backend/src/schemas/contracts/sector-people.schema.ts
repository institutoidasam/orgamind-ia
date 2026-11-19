import { z } from 'zod';
import {
  contactAuthorizationInputSchema,
  contactAuthorizationSchema,
} from './contact-authorization.schema';
import { levelRefSchema } from './level.schema';
import { sectorChannelSchema } from './sector.schema';

const idNameSchema = z.object({ id: z.string(), name: z.string() });

export const sectorPeopleRoleSchema = z.enum([
  'ADMIN',
  'OPERATOR',
  'SUPERVISOR',
  'VIEWER',
]);

/** C3. `editable`: 'full' = sem acesso; 'limited' = com acesso (só nível, função, turno). */
export const sectorPersonSchema = z.object({
  id: z.string(),
  name: z.string(),
  // GC8: null ao gestor quando `editable` = 'limited'; ADMIN recebe o número.
  phoneE164: z.string().nullable(),
  hasAccess: z.boolean(),
  // null quando sem acesso (o VIEWER da D1 não é exibido).
  role: sectorPeopleRoleSchema.nullable(),
  level: z
    .object({ id: z.string(), name: z.string(), isActive: z.boolean() })
    .nullable(),
  jobTitle: z.string().nullable(),
  shift: idNameSchema.nullable(),
  editable: z.enum(['full', 'limited']),
  // C6: ficha da pessoa (matrícula, situação e autorização de contato).
  registration: z.string().nullable(),
  isActive: z.boolean(),
  contactAuthorization: contactAuthorizationSchema,
});

export const sectorPeopleResponseSchema = z.object({
  sector: z.object({
    id: z.string(),
    name: z.string(),
    code: z.string(),
    isActive: z.boolean(),
    manager: z
      .object({ id: z.string(), name: z.string().nullable() })
      .nullable(),
    // C1: número efetivo da área (D2); null = "Sem número".
    channel: sectorChannelSchema.nullable(),
  }),
  // Com `sectorId` = este, nome asc pt-BR; só ativos, salvo `includeInactive`.
  people: sectorPersonSchema.array(),
  options: z.object({
    levels: levelRefSchema.array(), // ativos, por sortOrder
    shifts: idNameSchema.array(), // ativos, por sortOrder
  }),
});

// A3: a lista esconde inativos por padrão; `?includeInactive=true` os traz.
export const sectorPeopleListQuerySchema = z.object({
  includeInactive: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true'),
});

export const sectorPeopleSearchQuerySchema = z.object({
  q: z.string().trim().max(80).default(''),
});

/** Até 20, ativos, `sectorId` ≠ este. Gestor: só sem setor e sem acesso (D6). */
export const sectorPeopleCandidatesResponseSchema = z.object({
  items: z
    .object({
      id: z.string(),
      name: z.string(),
      hasAccess: z.boolean(),
      sector: idNameSchema.nullable(),
      // A1: matrícula como digitada; a busca por ela usa a chave em minúsculas.
      registration: z.string().nullable(),
    })
    .array(),
});

/** Até 30, mesmo filtro base de `GET /contacts`; `person` = usuário ligado ao contato. */
export const sectorContactCandidatesResponseSchema = z.object({
  items: z
    .object({
      contactId: z.string(),
      name: z.string().nullable(),
      phoneE164: z.string(),
      person: z
        .object({
          userId: z.string(),
          name: z.string(),
          sectorName: z.string().nullable(),
        })
        .nullable(),
    })
    .array(),
});

/**
 * Escrita (C3). `.strict()`: `email`, `role`, `hasAccess` ou `sectorId` no body
 * → 400; acesso, perfil e e-mail só existem em `/users` (ADMIN).
 */
const idSchema = z.string().min(1);
const idListSchema = idSchema.array().min(1).max(100);
const personNameSchema = z.string().trim().min(1).max(120);
const personPhoneSchema = z.string().trim().min(1).max(40);
const jobTitleSchema = z.string().trim().max(80).nullable();
// A1: vazio ou null limpa a matrícula (o `UsersService` normaliza).
const registrationSchema = z.string().trim().max(30).nullable();
// A4/D14: motivo de 3 a 200 caracteres; quem cobra é o serviço (`requireReason`).
const reasonSchema = z.string().trim().max(200);

// Q3: turno obrigatório (ativo, conferido no serviço) ao adicionar.
export const createSectorPersonBodySchema = z
  .object({
    name: personNameSchema,
    phone: personPhoneSchema,
    levelId: idSchema.nullable().optional(),
    jobTitle: jobTitleSchema.optional(),
    shiftId: idSchema,
    registration: registrationSchema.optional(),
    contactAuthorization: contactAuthorizationInputSchema.optional(),
  })
  .strict();

// Ids repetidos contam uma vez (serviço). Um turno e um nível para o lote.
export const addFromContactsBodySchema = z
  .object({
    contactIds: idListSchema,
    levelId: idSchema.nullable().optional(),
    shiftId: idSchema,
    // A2: uma escolha para o lote; nada vem de `Contact.sourceOrigin`.
    contactAuthorization: contactAuthorizationInputSchema.optional(),
  })
  .strict();

// D14: o motivo de mover é opcional e, quando vem, vai para a trilha.
export const movePeopleBodySchema = z
  .object({ userIds: idListSchema, reason: reasonSchema.optional() })
  .strict();

// D14: corpo opcional do DELETE; mesmo motivo opcional de mover.
export const removeSectorPersonBodySchema = z
  .object({ reason: reasonSchema.optional() })
  .strict();

// Pessoa com acesso: só `levelId`, `jobTitle` e `shiftId` (P1/D16, no serviço).
// O motivo (A4) é cobrado pelo serviço e não conta como campo editado.
export const updateSectorPersonBodySchema = z
  .object({
    name: personNameSchema.optional(),
    phone: personPhoneSchema.optional(),
    levelId: idSchema.nullable().optional(),
    jobTitle: jobTitleSchema.optional(),
    shiftId: idSchema.optional(),
    registration: registrationSchema.optional(),
    contactAuthorization: contactAuthorizationInputSchema.optional(),
    reason: reasonSchema.optional(),
  })
  .strict()
  .refine(
    (d) =>
      Object.entries(d).some(
        ([field, value]) => field !== 'reason' && value !== undefined,
      ),
    { message: 'Informe ao menos um campo' },
  );

// D6/A3: inativar e reativar pelo setor. O motivo (3 a 200) é cobrado pelo serviço.
export const sectorPersonStatusBodySchema = z
  .object({ isActive: z.boolean(), reason: reasonSchema.optional() })
  .strict();

export const sectorPeopleFailureReasonSchema = z.enum([
  'invalid_phone',
  'phone_taken',
  'already_person',
  'contact_not_found',
]);

/** D10: cada contato na sua transação; quem deu certo fica mesmo com falhas. */
export const addFromContactsResponseSchema = z.object({
  created: sectorPersonSchema.array(),
  failed: z
    .object({ contactId: z.string(), reason: sectorPeopleFailureReasonSchema })
    .array(),
});

export const movePeopleResponseSchema = z.object({
  moved: sectorPersonSchema.array(),
});

export type SectorPerson = z.infer<typeof sectorPersonSchema>;
export type SectorPeopleResponse = z.infer<typeof sectorPeopleResponseSchema>;
export type SectorPeopleListQuery = z.infer<typeof sectorPeopleListQuerySchema>;
export type SectorPersonStatusInput = z.infer<
  typeof sectorPersonStatusBodySchema
>;
export type SectorPeopleSearchQuery = z.infer<
  typeof sectorPeopleSearchQuerySchema
>;
export type SectorPeopleCandidatesResponse = z.infer<
  typeof sectorPeopleCandidatesResponseSchema
>;
export type SectorPeopleCandidate =
  SectorPeopleCandidatesResponse['items'][number];
export type SectorContactCandidatesResponse = z.infer<
  typeof sectorContactCandidatesResponseSchema
>;
export type SectorContactCandidate =
  SectorContactCandidatesResponse['items'][number];
export type CreateSectorPersonInput = z.infer<
  typeof createSectorPersonBodySchema
>;
export type AddFromContactsInput = z.infer<typeof addFromContactsBodySchema>;
export type UpdateSectorPersonInput = z.infer<
  typeof updateSectorPersonBodySchema
>;
export type RemoveSectorPersonInput = z.infer<
  typeof removeSectorPersonBodySchema
>;
export type SectorPeopleFailureReason = z.infer<
  typeof sectorPeopleFailureReasonSchema
>;
export type AddFromContactsResponse = z.infer<
  typeof addFromContactsResponseSchema
>;
export type MovePeopleResponse = z.infer<typeof movePeopleResponseSchema>;
