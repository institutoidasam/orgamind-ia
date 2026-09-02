import { z } from 'zod';
import { FailureReason } from '@prisma/client';
import { dateFromIso } from './date.schema';
import {
  CONTACT_VALIDITIES,
  type ContactValidity,
} from '../../shared/contact-validity';

export const contactSchema = z.object({
  id: z.string(),
  phoneE164: z.string(),
  name: z.string().nullable(),
  city: z.string().nullable(),
  group: z.string().nullable(),
  tags: z.array(z.string()),
  customFields: z.record(z.string(), z.unknown()).nullable(),
  optedOut: z.boolean(),
  createdAt: dateFromIso(),
  updatedAt: dateFromIso(),
  // Mirror the WhatsApp validation cache the Prisma model already holds — the
  // controller has been returning these straight from the row, but the
  // contract schema didn't list them, so any drift was invisible until it
  // hit the UI as `undefined` icons.
  whatsappValid: z.boolean().nullable(),
  whatsappCheckedAt: dateFromIso().nullable(),
  profilePictureUrl: z.string().nullable(),
  waLabels: z.array(z.string()),
  // ZE — o CACHE de marketing-reachability.ts (mesma história dos campos
  // acima): o controller já devolvia estas três colunas direto da row do
  // Prisma, mas o contrato nunca as declarou. Ficaram invisíveis para quem
  // confia no schema — e o primeiro parse/strip de saída as apagaria sem
  // ninguém notar.
  marketingUndeliverableAt: dateFromIso().nullable(),
  marketingUndeliverableCode: z.string().nullable(),
  marketingUndeliverableReason: z.string().nullable(),
  // F2 — flag durável de falha DEFINITIVA (classifyFailure), no mesmo molde do
  // marketingUndeliverable* acima. Ver o comentário de Contact.lastFailure* em
  // schema.prisma: sobrevive ao retry, é o que a tela do contato e o filtro de
  // campanha leem.
  lastFailureReason: z.nativeEnum(FailureReason).nullable(),
  lastFailureCode: z.string().nullable(),
  lastFailureAt: dateFromIso().nullable(),
  failureCount: z.number().int(),
});

/**
 * "Quais campanhas este contato RECEBEU" — o resumo que a coluna da lista
 * mostra. `names` vem ordenado por DATA DE CRIAÇÃO DA CAMPANHA (mais nova
 * primeiro), e NÃO por quando este contato recebeu: ordenar por recebimento
 * exigiria um MAX(sentAt) por par contato × campanha, que o agregado da
 * listagem deliberadamente não paga. Trate a ordem como estável, não como
 * cronologia de entrega.
 *
 * `count` é redundante com `names.length` de propósito: são campos separados
 * para que quem exibe o número o leia de uma fonte própria, mesmo que a tela
 * decida um dia mostrar só parte dos nomes. Hoje a célula não corta nada — usa
 * o `count` no chip e TODOS os nomes no `title`. Os IDs NÃO vêm aqui: quem
 * alimenta o <select> do filtro é a lista de campanhas (endpoint próprio), não
 * a célula de um contato.
 */
export const campaignsReceivedSchema = z.object({
  count: z.number().int(),
  names: z.array(z.string()),
});

/**
 * A LINHA DA LISTA de contatos = o Contact cru + a agregação de campanhas.
 *
 * Schema derivado, e não um campo opcional no `contactSchema`, porque só a
 * listagem agrega: `create`/`update` devolvem a row do Prisma e não têm
 * `campaignsReceived`. Declarar o campo como obrigatório lá em cima faria o
 * contrato mentir sobre esses dois endpoints; declará-lo opcional obrigaria
 * toda a tela a tratar um caso que na lista nunca acontece.
 */
export const contactListItemSchema = contactSchema.extend({
  campaignsReceived: campaignsReceivedSchema,
  // B.6, review (achado 1) — a validade JÁ CLASSIFICADA no servidor (mesmo
  // critério de `classifyContactValidity`, incluindo a sonda de entrega
  // provada que só o back pode fazer). Sem isto o front derivava a validade
  // com só `whatsappValid`+`lastFailureReason` e discordava do filtro
  // `?validity=valid`/do export para quem tinha ENTREGA PROVADA mas nunca foi
  // validado ativamente.
  validity: z.enum(CONTACT_VALIDITIES),
});

export const listContactsQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
  search: z.string().optional(),
  city: z.string().optional(),
  group: z.string().optional(),
  // NOT z.coerce.boolean(): in zod v4 it coerces any non-empty string to true,
  // so `?optedOut=false` inverted the filter. z.stringbool() maps the literal
  // "true"/"false" query values to real booleans. Empty string (?optedOut=)
  // is treated as absent (no filter) rather than a 400.
  // The OUTER .optional() is required: in zod 4.4.1 a `preprocess(...)` whose
  // inner schema is optional is NOT itself treated as an optional object key, so
  // a *missing* param threw `expected nonoptional`. Wrapping the pipe in
  // .optional() makes the key truly optional across zod versions.
  optedOut: z
    .preprocess((v) => (v === '' ? undefined : v), z.stringbool().optional())
    .optional(),
  // F2 T6 — filtro por "última falha definitiva" (Contact.lastFailureReason).
  // z.nativeEnum, não z.string(): um valor fora do enum não identifica motivo
  // real nenhum (mesma razão do historyRuleSchema.failureReason, F2 T5).
  failureReason: z.nativeEnum(FailureReason).optional(),
  // Filtra "quem RECEBEU esta campanha" — a direção inversa do wizard, que usa
  // o mesmo predicado para EXCLUIR da audiência. O `preprocess('' -> undefined)`
  // segue o idioma do optedOut acima: o <select> manda `?receivedCampaignId=`
  // quando o operador escolhe "todas", e isso é "sem filtro", não um 400.
  receivedCampaignId: z
    .preprocess((v) => (v === '' ? undefined : v), z.string().min(1).optional())
    .optional(),
  // B.3 — "Validação: todos / válidos / inválidos / não validados".
  // O `preprocess` aceita DOIS sentinelas de "sem filtro": a string vazia (o
  // idioma já usado por optedOut/receivedCampaignId) e `all`, porque o
  // <select> do Radix não aceita value="" e usa "all" como opção neutra —
  // um link colado com `?validity=all` tem de significar "todos", nunca 400.
  validity: z
    .preprocess(
      (v) => (v === '' || v === 'all' ? undefined : v),
      z.enum(CONTACT_VALIDITIES).optional(),
    )
    .optional(),
});

/**
 * O export usa EXATAMENTE os mesmos parâmetros da lista, menos a paginação: o
 * operador exporta o que está vendo. `omit` (e não um schema novo escrito à
 * mão) porque um filtro que entrasse só num dos dois faria a planilha divergir
 * da tela — e a planilha é o que vai voltar para quem passa os contatos.
 */
export const exportContactsQuerySchema = listContactsQuerySchema.omit({
  page: true,
  pageSize: true,
});

export const updateContactSchema = z.object({
  name: z.string().optional(),
  city: z.string().optional(),
  group: z.string().optional(),
  tags: z.array(z.string()).optional(),
  optedOut: z.boolean().optional(),
});

export const createContactSchema = z.object({
  phone: z.string().min(8, 'Telefone obrigatório'),
  name: z.string().optional(),
  city: z.string().optional(),
  group: z.string().optional(),
  tags: z.array(z.string()).default([]),
});

export const bulkDeleteContactsSchema = z
  .object({
    ids: z.array(z.string().min(1)).optional(),
    all: z.boolean().optional(),
    // B.3 — apagar em massa POR CLASSE DE VALIDADE. Enum de UM VALOR SÓ, de
    // propósito: "apagar todos os não validados" ou "todos os válidos" não é
    // ação de produto nenhuma — é um jeito de perder a base inteira num
    // clique. O único conjunto que o cliente pediu para apagar é o dos
    // inválidos confirmados.
    validity: z.enum(['invalid']).optional(),
    // Round 1 (pré-revisão) — a confirmação que o operador DIGITOU na tela
    // ("apagar N contatos"). Opcional para não quebrar `ids`/`all`, que nunca
    // tiveram esse gate; quando presente com `validity`, o serviço recusa a
    // exclusão se a contagem viva no banco não bater mais com este número —
    // sinal de que a lista mudou desde que o operador olhou para ela.
    expectedCount: z.number().int().min(0).optional(),
  })
  .refine(
    (v) =>
      (v.ids && v.ids.length > 0) || v.all === true || v.validity !== undefined,
    { message: 'Provide ids[], all=true or validity' },
  )
  // Round 2 (revisão) — `expectedCount` só faz sentido junto de `validity`: é
  // a contagem viva do MESMO predicado que o serviço confere antes de apagar.
  // Nos caminhos `ids`/`all` não existe "contagem viva do filtro" nenhuma para
  // comparar, então aceitá-lo ali seria um campo que o servidor lê e ignora em
  // silêncio — o pior tipo de confirmação: parece que protege e não protege.
  .refine((v) => v.expectedCount === undefined || v.validity !== undefined, {
    message: 'expectedCount só vale com validity',
  });

export const setContactLabelsSchema = z.object({
  labelIds: z.array(z.string().min(1)),
});

export const importSummarySchema = z.object({
  batchId: z.string(),
  total: z.number().int(),
  created: z.number().int(),
  updated: z.number().int(),
  invalid: z.number().int(),
  duplicates: z.number().int(),
});

export type Contact = z.infer<typeof contactSchema>;
export type CampaignsReceived = z.infer<typeof campaignsReceivedSchema>;
export type ContactListItem = z.infer<typeof contactListItemSchema>;
export type ListContactsQuery = z.infer<typeof listContactsQuerySchema>;
export type ExportContactsQuery = z.infer<typeof exportContactsQuerySchema>;
export type { ContactValidity };
export type UpdateContact = z.infer<typeof updateContactSchema>;
export type CreateContact = z.infer<typeof createContactSchema>;
export type BulkDeleteContacts = z.infer<typeof bulkDeleteContactsSchema>;
export type SetContactLabels = z.infer<typeof setContactLabelsSchema>;
export type ImportSummary = z.infer<typeof importSummarySchema>;
