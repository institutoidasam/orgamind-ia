import { z } from 'zod';
import { levelRefSchema } from './level.schema';

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
  }),
  // Ativos com `sectorId` = este, nome asc pt-BR.
  people: sectorPersonSchema.array(),
  options: z.object({
    levels: levelRefSchema.array(), // ativos, por sortOrder
    shifts: idNameSchema.array(), // ativos, por sortOrder
  }),
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

// Q3: turno obrigatório (ativo, conferido no serviço) ao adicionar.
export const createSectorPersonBodySchema = z
  .object({
    name: personNameSchema,
    phone: personPhoneSchema,
    levelId: idSchema.nullable().optional(),
    jobTitle: jobTitleSchema.optional(),
    shiftId: idSchema,
  })
  .strict();

// Ids repetidos contam uma vez (serviço). Um turno e um nível para o lote.
export const addFromContactsBodySchema = z
  .object({
    contactIds: idListSchema,
    levelId: idSchema.nullable().optional(),
    shiftId: idSchema,
  })
  .strict();

export const movePeopleBodySchema = z
  .object({ userIds: idListSchema })
  .strict();

// Pessoa com acesso: só `levelId`, `jobTitle` e `shiftId` (P1, no serviço).
export const updateSectorPersonBodySchema = z
  .object({
    name: personNameSchema.optional(),
    phone: personPhoneSchema.optional(),
    levelId: idSchema.nullable().optional(),
    jobTitle: jobTitleSchema.optional(),
    shiftId: idSchema.optional(),
  })
  .strict()
  .refine((d) => Object.values(d).some((value) => value !== undefined), {
    message: 'Informe ao menos um campo',
  });

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
export type SectorPeopleFailureReason = z.infer<
  typeof sectorPeopleFailureReasonSchema
>;
export type AddFromContactsResponse = z.infer<
  typeof addFromContactsResponseSchema
>;
export type MovePeopleResponse = z.infer<typeof movePeopleResponseSchema>;
