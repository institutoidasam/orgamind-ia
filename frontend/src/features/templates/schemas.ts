import { z } from 'zod';
import { CHANNEL_PROVIDERS, type ChannelProvider } from '@/features/whatsapp/api';

// Meta template names are lowercase-only (the sync key is case-sensitive), so
// we reject uppercase here — no `/i` flag — to mirror the backend contract.
const metaNameRegex = /^[a-z0-9_]+$/;

// Twilio Content SID: uppercase `HX` + 32 hex chars — mirrors the backend.
const twilioContentSidRegex = /^HX[0-9a-fA-F]{32}$/;

export const templateCategoryEnum = z.enum([
  'MARKETING',
  'UTILITY',
  'AUTHENTICATION',
]);

// PAUSED (twilio-platform T2): Meta pausou/desabilitou um template aprovado —
// nunca aparece no wizard de campanha (gate: só APPROVED é selecionável).
export const templateStatusEnum = z.enum([
  'PENDING',
  'APPROVED',
  'REJECTED',
  'PAUSED',
]);

export const templateKindEnum = z.enum(['TEXT', 'LIST', 'BUTTONS', 'POLL']);
export type TemplateKind = z.infer<typeof templateKindEnum>;

/** O papel declarado de um botão de resposta rápida (ZERNIO). */
export const zernioButtonRoleEnum = z.enum(['OPT_IN', 'OPT_OUT', 'NONE']);
export type ZernioButtonRoleValue = z.infer<typeof zernioButtonRoleEnum>;

// Multi-provider channels — templates are now provider-owned. Mirrors the
// Prisma `ChannelProvider` enum via the same UPPERCASE constant `whatsapp/api`
// already exports, so both features share one source of truth.
export const channelProviderEnum = z.enum(CHANNEL_PROVIDERS);
export type { ChannelProvider };

export const templateSchema = z.object({
  id: z.string(),
  metaName: z.string(),
  language: z.string(),
  body: z.string(),
  variables: z.array(z.string()),
  status: templateStatusEnum,
  category: templateCategoryEnum,
  createdAt: z.coerce.date(),
  kind: templateKindEnum.default('TEXT'),
  interactiveConfig: z.unknown().nullable().optional(),
  twilioContentSid: z.string().nullable().optional(),
  provider: channelProviderEnum,
  // twilio-platform T3 — colunas escritas pelo job de sync do catálogo Twilio
  // (a cada ~2 min no worker): status BRUTO reportado pela Twilio, motivo de
  // rejeição (ou "Template removido na Twilio") e quando o sync tocou a row
  // pela última vez. Nulos em templates que o sync nunca tocou
  // (EVOLUTION/ZERNIO/META).
  twilioApprovalStatus: z.string().nullable().optional(),
  twilioRejectionReason: z.string().nullable().optional(),
  lastTwilioSyncAt: z.coerce.date().nullable().optional(),
  // ZC — o espelho do trio acima para o ZERNIO. `zernioStatusRaw` é o status
  // BRUTO da Meta: o enum `status` é um mapeamento COM PERDA (DISABLED e
  // PENDING_DELETION viram ambos PAUSED), e é o raw que diz ao operador QUAL dos
  // dois de fato aconteceu.
  zernioTemplateId: z.string().nullable().optional(),
  zernioStatusRaw: z.string().nullable().optional(),
  zernioRejectionReason: z.string().nullable().optional(),
  lastZernioSyncAt: z.coerce.date().nullable().optional(),
  /**
   * ★ ZB — o VEREDITO dos botões, calculado PELO BACKEND (GET /templates).
   *
   * O frontend não pode calculá-lo: quem sabe se o clique em "Bora, quero!" é
   * reconhecido como aceite é o reconhecedor, e ele é uma LISTA FECHADA que vive
   * no backend. Uma cópia aqui divergiria no primeiro rótulo novo — e a
   * divergência não dá erro: apaga consentimento em silêncio.
   *
   * `null` = nada a dizer (não é ZERNIO, ou não tem resposta rápida).
   * `problems` não-vazio = o template NÃO dispara (o gate de campanha recusa).
   */
  consentButtons: z
    .object({
      /** Os rótulos como a META os guardou — é o que volta no clique. */
      labels: z.array(z.string()),
      declared: z.array(
        z.object({ text: z.string(), role: zernioButtonRoleEnum }),
      ),
      problems: z.array(z.string()),
    })
    .nullable()
    .optional(),
});
export type Template = z.infer<typeof templateSchema>;

export const createTemplateSchema = z
  .object({
    metaName: z
      .string()
      .min(1, 'Obrigatório')
      .max(512)
      .regex(
        metaNameRegex,
        'Somente letras minúsculas, números e _ (sem espaços ou acentos)',
      ),
    language: z.string().min(2).default('pt_BR'),
    // For TEXT kind body holds the message. For interactive kinds the form
    // sends an empty string so the field stays present in the payload.
    body: z.string().optional(),
    category: templateCategoryEnum.default('UTILITY'),
    kind: templateKindEnum.default('TEXT'),
    interactiveConfig: z.unknown().nullable().optional(),
    twilioContentSid: z
      .string()
      .regex(twilioContentSidRegex, 'Content SID inválido (HX…)')
      .or(z.literal(''))
      .nullable()
      .optional(),
    // Multi-provider channels — the operator must choose a provider; default
    // mirrors the backend's historical EVOLUTION default.
    provider: channelProviderEnum.default('EVOLUTION'),
  })
  .refine(
    (v) => v.kind !== 'TEXT' || (v.body !== undefined && v.body.length > 0),
    {
      message: 'Obrigatório',
      path: ['body'],
    },
  )
  .refine(
    (v) =>
      v.kind === 'TEXT' ||
      (v.interactiveConfig !== undefined && v.interactiveConfig !== null),
    {
      message: 'Configuração obrigatória para este tipo',
      path: ['interactiveConfig'],
    },
  )
  // twilioContentSid only makes sense for the TWILIO provider — mirrors the
  // backend's createTemplateSchema cross-field refines exactly (PT messages).
  .refine(
    (v) => v.provider !== 'TWILIO' || !!v.twilioContentSid,
    {
      message:
        'Templates do provedor Twilio exigem o campo Content SID (aprovado na Twilio).',
      path: ['twilioContentSid'],
    },
  )
  .refine(
    (v) => v.provider === 'TWILIO' || !v.twilioContentSid,
    {
      message: 'Content SID só é permitido para templates do provedor Twilio.',
      path: ['twilioContentSid'],
    },
  )
  /**
   * ZB — espelha o refine do backend: template ZERNIO NÃO nasce aqui.
   *
   * Este endpoint grava `status: APPROVED` sem falar com provedor nenhum. Para
   * EVOLUTION isso é correto (não há aprovação da Meta); para ZERNIO seria uma
   * row "aprovada" de um template que a Meta nunca viu — passa no gate de
   * campanha e só explode no envio. O backend recusa; sem este refine o request
   * saía e voltava um 400 mudo.
   */
  .refine((v) => v.provider !== 'ZERNIO', {
    message:
      'Template Zernio não é criado por aqui — use "Novo template Zernio", que cria o template de verdade na Meta (com botões) e nasce pendente de aprovação.',
    path: ['provider'],
  });
export type CreateTemplate = z.infer<typeof createTemplateSchema>;

/**
 * Os provedores que o form GENÉRICO pode oferecer. ZERNIO fica de fora: lá o
 * template tem de nascer na Meta (POST /templates/zernio), com o rótulo dos
 * botões casado com o reconhecedor. Deixar a opção no select era oferecer um
 * caminho que só falha.
 *
 * TWILIO também fica de fora (pedido do cliente, 2026-08-25): o provedor
 * ativo agora é o GOZAP, e a Twilio deixou de ser oferecida na criação — o
 * fluxo dedicado da Twilio (rascunho → submissão) continua existindo para
 * quem já tem templates lá, só não aparece mais como opção aqui.
 */
export const GENERIC_TEMPLATE_PROVIDERS = CHANNEL_PROVIDERS.filter(
  (p) => p !== 'ZERNIO' && p !== 'TWILIO',
);

/**
 * Idiomas oferecidos no SELECT de idioma do template (pedido do cliente,
 * 2026-08-25: antes era texto livre e não ficava claro o que era aceito).
 * pt_BR é o padrão; en_US e es_ES são os poucos outros realmente usados.
 * Editar um template legado com um idioma fora desta lista continua
 * funcionando — o form injeta o valor atual como opção extra em vez de
 * perdê-lo (ver template-form-dialog.tsx).
 */
export const TEMPLATE_LANGUAGE_OPTIONS = [
  { value: 'pt_BR', label: 'Português (Brasil) — pt_BR' },
  { value: 'en_US', label: 'Inglês (EUA) — en_US' },
  { value: 'es_ES', label: 'Espanhol — es_ES' },
] as const;

export const updateTemplateSchema = z.object({
  language: z.string().min(2).optional(),
  body: z.string().min(1).optional(),
  category: templateCategoryEnum.optional(),
  status: templateStatusEnum.optional(),
  kind: templateKindEnum.optional(),
  interactiveConfig: z.unknown().nullable().optional(),
  twilioContentSid: z
    .string()
    .regex(twilioContentSidRegex, 'Content SID inválido (HX…)')
    .or(z.literal(''))
    .nullable()
    .optional(),
  // Multi-provider channels — cross-field consistency (provider vs
  // twilioContentSid) is enforced by the form via createTemplateSchema's
  // refines (the edit dialog reuses that schema as its resolver) and, as a
  // backstop, by the backend against the EFFECTIVE merged values.
  provider: channelProviderEnum.optional(),
});
export type UpdateTemplate = z.infer<typeof updateTemplateSchema>;

export type SyncTemplatesResponse = { synced: number };

/**
 * Extracts placeholder names from a template body, supporting both
 * positional and named tokens. Returns names in first-seen order,
 * deduplicated and trimmed. Used for the live preview in the editor.
 */
export function extractVariables(body: string): string[] {
  const re = /\{\{\s*([^}\s][^}]*?)\s*\}\}/g;
  const seen = new Set<string>();
  const out: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(body)) !== null) {
    const name = match[1].trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}
