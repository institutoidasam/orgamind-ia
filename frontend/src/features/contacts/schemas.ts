import { z } from 'zod';
import { FAILURE_REASONS, type FailureReason } from '@/features/campaigns/schemas';
import { CONTACT_VALIDITIES, type ContactValidity } from './validity';

/**
 * Pure (honest) shape of a contact as it arrives from the API. The response is
 * never run through a runtime parser — `contacts/api.ts` casts via
 * `.json<Contact>()` — so a Zod schema with `z.coerce.date()` was pure false
 * safety: nothing coerced anything, and the inferred `createdAt: Date` was a
 * lie (the wire value is an ISO string). Date-ish fields are therefore typed as
 * `string | Date`; callers wrap them in `new Date(...)` before formatting.
 */
export type Contact = {
  id: string;
  phoneE164: string;
  name: string | null;
  city: string | null;
  group: string | null;
  tags: string[];
  customFields: Record<string, unknown> | null;
  optedOut: boolean;
  whatsappValid: boolean | null;
  whatsappCheckedAt: string | Date | null;
  profilePictureUrl: string | null;
  // Mirror of the WhatsApp Business labels assigned to this contact.
  waLabels: string[];
  createdAt: string | Date;
  updatedAt: string | Date;
  // ZE — o CACHE de marketing-reachability.ts: o back já devolve estas três
  // colunas direto da row (nenhum `select` nem interceptor de serialização as
  // esconde), mas o tipo do front nunca as declarou. Espelha
  // `backend/src/schemas/contracts/contact.schema.ts`.
  marketingUndeliverableAt: string | Date | null;
  marketingUndeliverableCode: string | null;
  marketingUndeliverableReason: string | null;
  // F2 T9 — flag durável de falha DEFINITIVA (classifyFailure), no mesmo
  // molde do marketingUndeliverable* acima. É o que a coluna/chip de motivo
  // de falha e o filtro `failureReason` da lista de contatos leem.
  lastFailureReason: FailureReason | null;
  lastFailureCode: string | null;
  lastFailureAt: string | Date | null;
  failureCount: number;
};

/**
 * F3 — "quais campanhas este contato RECEBEU", o resumo que a coluna da lista
 * mostra. Espelha `campaignsReceivedSchema` do back
 * (`backend/src/schemas/contracts/contact.schema.ts`).
 *
 * `names` chega ordenado por DATA DE CRIAÇÃO DA CAMPANHA (mais nova primeiro),
 * NÃO por quando o contato recebeu — o back ordena o `findMany` de Campaign por
 * `createdAt` desc, e ordenar por recebimento exigiria um MAX(sentAt) por par
 * contato × campanha. Não leia essa ordem como cronologia de entrega.
 *
 * Nada é truncado hoje: a célula mostra o `count` cheio no chip e TODOS os
 * nomes no `title`. `count` continua sendo um campo próprio (e não
 * `names.length`) para que o número não dependa de a tela ter cortado a lista,
 * caso um dia corte.
 */
export type CampaignsReceived = {
  count: number;
  names: string[];
};

/**
 * A LINHA DA LISTA = o `Contact` cru + a agregação de campanhas.
 *
 * Tipo derivado, e não mais uma chave (opcional) no `Contact`, porque só a
 * listagem agrega: `create`/`update` devolvem a row do Prisma e não têm
 * `campaignsReceived`. Espelha o `contactListItemSchema` do back — e a
 * consequência prática para a tela é que na lista o campo está SEMPRE
 * presente (quem não recebeu nada vem `{count:0,names:[]}`), então a célula
 * não precisa de guard de `undefined`.
 */
export type ContactListItem = Contact & {
  campaignsReceived: CampaignsReceived;
  // B.6, review (achado 1) — a validade JÁ CLASSIFICADA no servidor
  // (`classifyContactValidity`, com a sonda de entrega provada que só o back
  // pode fazer). Opcional porque uma resposta em CACHE do React Query, de
  // ANTES desta mudança, pode não trazer o campo — nesse caso
  // `contactValidityOf` cai de volta na derivação local antiga.
  validity?: ContactValidity;
};

export const listContactsQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
  search: z.string().optional(),
  city: z.string().optional(),
  group: z.string().optional(),
  optedOut: z.coerce.boolean().optional(),
  // F2 T9 — espelha `listContactsQuerySchema.failureReason` do back
  // (`backend/src/schemas/contracts/contact.schema.ts`): filtra por
  // `Contact.lastFailureReason`. Enum fechado, não `z.string()`, pelo mesmo
  // motivo do `historyRuleSchema.failureReason` (F2 T5) — um valor fora do
  // enum não identifica motivo real nenhum.
  failureReason: z.enum(FAILURE_REASONS).optional(),
  // F3 — "quem RECEBEU esta campanha", a direção inversa da exclusão do
  // wizard (que usa o MESMO predicado, REACHED_STATUSES, para tirar da
  // audiência). `z.string()` e não enum: o valor é um cuid vindo da lista de
  // campanhas, que só o back sabe validar.
  receivedCampaignId: z.string().min(1).optional(),
  // B.3 — espelha `listContactsQuerySchema.validity` do back.
  validity: z.enum(CONTACT_VALIDITIES).optional(),
});
export type ListContactsQuery = z.infer<typeof listContactsQuerySchema>;
export type { ContactValidity };

/**
 * Espelho de `CONTACT_EXPORT_ROW_CAP` (backend/src/modules/contacts/
 * contacts-export.service.ts). A tela usa isto só para DESABILITAR o botão
 * antes do clique — quem recusa de verdade é o backend, com 400.
 */
export const CONTACT_EXPORT_ROW_CAP = 50_000;

export type ContactsListResponse = {
  items: ContactListItem[];
  total: number;
  page: number;
  pageSize: number;
};

export const createContactSchema = z.object({
  phone: z.string().min(8, 'Telefone obrigatório (mínimo 8 dígitos)'),
  name: z.string().optional(),
  city: z.string().optional(),
  group: z.string().optional(),
  // Combobox de tags entrega o array pronto (já sem vazios/duplicatas) — não
  // é mais texto "separado por vírgula" para parsear no submit.
  tags: z.array(z.string()).optional(),
});
export type CreateContactInput = z.infer<typeof createContactSchema>;

/**
 * Edit-mode form schema: same fields as create plus the opt-out toggle. The
 * `optedOut` key MUST live in the zod schema, otherwise react-hook-form's
 * resolver strips it from the parsed `data` and the checkbox silently does
 * nothing on submit.
 */
export const editContactSchema = createContactSchema.extend({
  optedOut: z.boolean().optional(),
});
export type EditContactInput = z.infer<typeof editContactSchema>;
