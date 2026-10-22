import { z } from 'zod';

/**
 * Espelho à mão do contrato do back (`backend/src/schemas/contracts/sector-people.schema.ts`).
 * O back é a fonte: mudou lá, muda aqui no mesmo PR.
 */

const idNameSchema = z.object({ id: z.string(), name: z.string() });

/** `editable`: 'full' = sem acesso; 'limited' = com acesso (só nível, função e turno). */
export const sectorPersonSchema = z.object({
  id: z.string(),
  name: z.string(),
  // null ao gestor quando `editable` = 'limited' (GC8): a tela mostra "—".
  phoneE164: z.string().nullable(),
  hasAccess: z.boolean(),
  role: z.enum(['ADMIN', 'OPERATOR', 'SUPERVISOR', 'VIEWER']).nullable(),
  level: z.object({ id: z.string(), name: z.string(), isActive: z.boolean() }).nullable(),
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
    manager: z.object({ id: z.string(), name: z.string().nullable() }).nullable(),
  }),
  people: sectorPersonSchema.array(),
  options: z.object({
    levels: idNameSchema.array(),
    shifts: idNameSchema.array(),
  }),
});

export type SectorPerson = z.infer<typeof sectorPersonSchema>;
export type SectorPeopleResponse = z.infer<typeof sectorPeopleResponseSchema>;
export type SectorPeopleOptions = SectorPeopleResponse['options'];

/** PATCH: só os campos que mudaram; pessoa com acesso aceita só `levelId`, `jobTitle` e `shiftId`. */
export type UpdateSectorPersonInput = {
  name?: string;
  phone?: string;
  levelId?: string | null;
  jobTitle?: string | null;
  shiftId?: string;
};

const phoneDigitsOk = (value: string) => {
  const digits = value.replace(/\D/g, '');
  return digits.length >= 10 && digits.length <= 15;
};

export const personFormSchema = z.object({
  name: z.string().trim().max(120).optional(),
  phone: z
    .string()
    .trim()
    .optional()
    .refine((value) => !value || phoneDigitsOk(value), 'Informe DDD + número'),
  levelId: z.string().nullable().optional(),
  jobTitle: z.string().trim().max(80, 'Use até 80 caracteres').nullable().optional(),
  shiftId: z.string().nullable().optional(),
});
export type PersonFormInput = z.infer<typeof personFormSchema>;

/** Sem acesso o nome é obrigatório (o servidor recusa pessoa sem nome). */
export const personFormSchemaFor = (editable: SectorPerson['editable']) =>
  personFormSchema.superRefine((value, ctx) => {
    if (editable === 'full' && !value.name?.trim()) {
      ctx.addIssue({ code: 'custom', path: ['name'], message: 'Informe o nome' });
    }
  });

/** Candidatos e escrita do diálogo "Adicionar pessoas" (C3). */
export const sectorPersonCandidatesSchema = z.object({
  items: z
    .object({
      id: z.string(),
      name: z.string(),
      hasAccess: z.boolean(),
      sector: idNameSchema.nullable(),
    })
    .array(),
});

export const sectorContactCandidatesSchema = z.object({
  items: z
    .object({
      contactId: z.string(),
      // D11: contato sem nome aparece pelo número.
      name: z.string().nullable(),
      phoneE164: z.string(),
      person: z.object({ userId: z.string(), name: z.string(), sectorName: z.string().nullable() }).nullable(),
    })
    .array(),
});

export const sectorPeopleFailureReasonSchema = z.enum(['invalid_phone', 'phone_taken', 'already_person', 'contact_not_found']);

/** D10: cada contato na sua transação; quem deu certo fica mesmo com falhas. */
export const addFromContactsResponseSchema = z.object({
  created: sectorPersonSchema.array(),
  failed: z.object({ contactId: z.string(), reason: sectorPeopleFailureReasonSchema }).array(),
});

export const movePeopleResponseSchema = z.object({ moved: sectorPersonSchema.array() });

export type SectorPersonCandidate = z.infer<typeof sectorPersonCandidatesSchema>['items'][number];
export type SectorContactCandidate = z.infer<typeof sectorContactCandidatesSchema>['items'][number];
export type SectorPeopleFailureReason = z.infer<typeof sectorPeopleFailureReasonSchema>;
export type AddFromContactsResponse = z.infer<typeof addFromContactsResponseSchema>;

/** Q3: `shiftId` obrigatório ao adicionar (turno ativo; o servidor confere). */
export type CreateSectorPersonInput = {
  name: string;
  phone: string;
  levelId: string | null;
  jobTitle: string | null;
  shiftId: string;
};
export type AddFromContactsInput = { contactIds: string[]; levelId: string | null; shiftId: string };

/** Aba "Nova pessoa": nome e telefone obrigatórios; turno sem pré-seleção ('' até o gestor escolher). */
export const newPersonFormSchema = z.object({
  name: z.string().trim().min(1, 'Informe o nome').max(120),
  phone: z
    .string()
    .trim()
    .min(1, 'Informe o telefone')
    .refine(phoneDigitsOk, 'Informe DDD + número'),
  levelId: z.string().nullable(),
  jobTitle: z.string().trim().max(80, 'Use até 80 caracteres'),
  shiftId: z.string().min(1, 'Escolha o turno'),
});
export type NewPersonFormInput = z.infer<typeof newPersonFormSchema>;
