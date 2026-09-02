import { z } from 'zod';
import {
  channelProviderEnum,
  type ChannelProviderContract,
} from './channel-provider.schema';
import { dateFromIso } from './date.schema';

// Meta template names are lowercase; the unique/sync key is case-sensitive, so
// we reject uppercase here (no `/i` flag) to avoid divergence between a manually
// created name and the one Meta reports back during sync.
const metaNameRegex = /^[a-z0-9_]+$/;

// Twilio Content SID: an uppercase `HX` followed by 32 hex chars.
const twilioContentSidRegex = /^HX[0-9a-fA-F]{32}$/;

export const templateCategoryEnum = z.enum([
  'MARKETING',
  'UTILITY',
  'AUTHENTICATION',
]);

// PAUSED (twilio-platform T2): Meta pausou/desabilitou um template aprovado —
// fica FORA do gate de campanha (o wizard só oferece APPROVED).
export const templateStatusEnum = z.enum([
  'PENDING',
  'APPROVED',
  'REJECTED',
  'PAUSED',
]);

// Multi-provider channels: the provider a template targets. A template's
// provider must match the provider of any channel it's sent through (enforced
// at campaign create/run — see campaigns.service.ts). Re-exported from
// channel-provider.schema.ts (the single source — see that file).
export { channelProviderEnum, type ChannelProviderContract };

export const templateKindSchema = z.enum(['TEXT', 'LIST', 'BUTTONS', 'POLL']);
export type TemplateKind = z.infer<typeof templateKindSchema>;

// LIST — interactive list message (a bottom-sheet picker on WhatsApp).
const listRowSchema = z.object({
  rowId: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
});
const listSectionSchema = z.object({
  title: z.string().min(1),
  rows: z.array(listRowSchema).min(1),
});
export const listConfigSchema = z.object({
  title: z.string().min(1), // top of the list
  description: z.string().min(1), // body text above the button
  buttonText: z.string().min(1), // the "View" button label
  footerText: z.string().optional(),
  sections: z.array(listSectionSchema).min(1),
});

// BUTTONS — quick-reply buttons (max 3 per WhatsApp limits).
const buttonItemSchema = z.object({
  buttonId: z.string().min(1),
  title: z.string().min(1),
});
export const buttonsConfigSchema = z.object({
  title: z.string().optional(),
  description: z.string().min(1),
  footerText: z.string().optional(),
  buttons: z.array(buttonItemSchema).min(1).max(3),
});

// POLL — interactive poll with selectable options (2..12).
export const pollConfigSchema = z
  .object({
    question: z.string().min(1),
    options: z.array(z.string().min(1)).min(2).max(12),
    selectableOptionsCount: z.number().int().min(1).default(1),
  })
  .superRefine((cfg, ctx) => {
    // A voter can never select more options than exist.
    if (cfg.selectableOptionsCount > cfg.options.length) {
      ctx.addIssue({
        code: 'custom',
        message: 'selectableOptionsCount cannot exceed the number of options',
        path: ['selectableOptionsCount'],
      });
    }
  });

export type ListConfig = z.infer<typeof listConfigSchema>;
export type ButtonsConfig = z.infer<typeof buttonsConfigSchema>;
export type PollConfig = z.infer<typeof pollConfigSchema>;

/**
 * Extracts placeholder names from a template body, supporting both
 * positional ({{1}}) and named ({{name}}) tokens. Returns names in
 * first-seen order, deduplicated.
 *
 * Tokens MUST be literal `{{name}}` with no inner whitespace. Runtime
 * interpolation substitutes the literal `{{name}}` string (see
 * EvolutionApiAdapter.interpolate → replaceAll(`{{${k}}}`, v)), so a token
 * like `{{ name }}` could never be replaced — extracting it would put a
 * variable into the map whose placeholder survives into the sent message.
 * Keeping extraction strict guarantees every extracted name round-trips
 * through interpolation.
 */
export function extractTemplateVariables(body: string): string[] {
  const re = /\{\{([^}\s]+)\}\}/g;
  const seen = new Set<string>();
  const out: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(body)) !== null) {
    const name = match[1];
    if (!name) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

export const templateSchema = z.object({
  id: z.string(),
  metaName: z.string(),
  language: z.string(),
  body: z.string(),
  variables: z.array(z.string()),
  status: templateStatusEnum,
  category: templateCategoryEnum,
  createdAt: dateFromIso(),
  kind: templateKindSchema.default('TEXT'),
  interactiveConfig: z.unknown().nullable().optional(),
  twilioContentSid: z.string().nullable().optional(),
  provider: channelProviderEnum,
  // twilio-platform T3 — approval-sync columns written by the repeatable
  // template-approval-sync job (see template-approval-sync.processor.ts):
  // - twilioApprovalStatus: RAW status reported by Twilio (received, pending,
  //   approved, rejected, paused, disabled, …) — the mapped enum lives in
  //   `status`; the raw value is kept for display/debugging.
  // - twilioRejectionReason: Meta's rejection_reason (or "Template removido
  //   na Twilio" when the HX vanished from the catalog).
  // - lastTwilioSyncAt: when the sync job last touched the row — the frontend
  //   shows catalog freshness from it. All three are null for rows the sync
  //   never touched (EVOLUTION/ZERNIO/META templates).
  twilioApprovalStatus: z.string().nullable().optional(),
  twilioRejectionReason: z.string().nullable().optional(),
  lastTwilioSyncAt: dateFromIso().nullable().optional(),
});

export const createTemplateSchema = z
  .object({
    metaName: z
      .string()
      .min(1)
      .max(512)
      .regex(
        metaNameRegex,
        'metaName must contain only letters, digits and underscores',
      ),
    language: z.string().min(2).default('pt_BR'),
    // For TEXT kind body holds the actual text. For interactive kinds body
    // is optional/decorative — content lives in `interactiveConfig`. No
    // `.min(1)` here: the TEXT-only refine below guarantees a non-empty body
    // for TEXT, and interactive kinds legitimately send `body: ''`.
    body: z.string().optional(),
    category: templateCategoryEnum.default('UTILITY'),
    kind: templateKindSchema.default('TEXT'),
    interactiveConfig: z.unknown().nullable().optional(),
    twilioContentSid: z
      .string()
      .regex(twilioContentSidRegex, 'Content SID inválido (HX…)')
      .nullable()
      .optional(),
    // Multi-provider channels — defaults to EVOLUTION (the historical
    // behaviour) when the operator doesn't pick a provider explicitly.
    provider: channelProviderEnum.default('EVOLUTION'),
  })
  .refine(
    (v) => v.kind !== 'TEXT' || (v.body !== undefined && v.body.length > 0),
    {
      message: 'body is required for TEXT templates',
      path: ['body'],
    },
  )
  .refine(
    (v) =>
      v.kind === 'TEXT' ||
      (v.interactiveConfig !== undefined && v.interactiveConfig !== null),
    {
      message: 'interactiveConfig is required for non-TEXT templates',
      path: ['interactiveConfig'],
    },
  )
  // twilioContentSid only makes sense for the TWILIO provider — a Content
  // SID references a Twilio-approved template and can't be sent through
  // any other provider.
  .refine(
    (v) =>
      v.provider !== 'TWILIO' ||
      (v.twilioContentSid !== undefined && v.twilioContentSid !== null),
    {
      message:
        'Templates do provedor TWILIO exigem o campo twilioContentSid (Content SID aprovado).',
      path: ['twilioContentSid'],
    },
  )
  .refine(
    (v) =>
      v.provider === 'TWILIO' ||
      v.twilioContentSid === undefined ||
      v.twilioContentSid === null,
    {
      message:
        'twilioContentSid só é permitido para templates do provedor TWILIO.',
      path: ['twilioContentSid'],
    },
  )
  /**
   * ZB — a ARMADILHA que este endpoint escondia: ele aceitava `provider:'ZERNIO'`
   * e gravava `status: APPROVED` sem NUNCA falar com a Meta. A row resultante
   * passava no gate de campanha (que só exige APPROVED) e só explodia no envio —
   * ou, pior, "existia" para o operador sem existir na Meta.
   *
   * Template ZERNIO agora nasce por `POST /templates/zernio`, que cria de fato na
   * Meta, valida os rótulos de botão contra o reconhecedor e nasce PENDING.
   */
  .refine((v) => v.provider !== 'ZERNIO', {
    message:
      'Templates ZERNIO não podem ser criados por aqui (a row nasceria APROVADA sem existir na Meta). Use "Novo template Zernio", que cria o template de verdade na Meta e nasce pendente de aprovação.',
    path: ['provider'],
  });

// ── ZB — criar template (com botões) no Zernio ──────────────────────────────
// O contrato de request de POST /templates/zernio. Os LIMITES e o casamento de
// rótulo ficam na validação pura agregada em PT-BR
// (modules/templates/zernio-template-validation.ts) — aqui vive só o SHAPE.

/**
 * O papel do botão no fluxo de consentimento. Não é decoração: é o que o
 * servidor CONFERE contra o reconhecedor (`consent-button.schema`) antes de
 * deixar o template nascer. `NONE` significa "este botão não pode ser lido nem
 * como aceite nem como recusa" — e isso também é validado, porque o
 * reconhecimento no ingest é agnóstico de template.
 */
export const zernioButtonRoleEnum = z.enum(['OPT_IN', 'OPT_OUT', 'NONE']);

/**
 * Quick reply: o operador controla APENAS o `text`. Não há `buttonId` aqui, de
 * propósito — o Zernio não transporta payload de botão (nem na criação nem no
 * envio), e oferecer o campo faria o operador crer que o id importa, quando o
 * que decide tudo é o rótulo.
 */
const zernioQuickReplyButtonSchema = z.object({
  type: z.literal('QUICK_REPLY'),
  text: z.string().min(1),
  role: zernioButtonRoleEnum.default('NONE'),
});

const zernioUrlButtonSchema = z.object({
  type: z.literal('URL'),
  text: z.string().min(1),
  url: z.string().min(1),
});

export const zernioTemplateButtonSchema = z.discriminatedUnion('type', [
  zernioQuickReplyButtonSchema,
  zernioUrlButtonSchema,
]);

/**
 * As categorias que este endpoint sabe MONTAR. AUTHENTICATION fica de fora: na
 * Meta um template de autenticação tem forma RÍGIDA (corpo fixo + botão
 * OTP/copy-code), não aceita corpo livre nem quick reply arbitrária, e o
 * `buildZernioComponents` só emite BODY/FOOTER/BUTTONS. Oferecer o caminho seria
 * oferecer uma REJEIÇÃO CERTA da Meta 24h depois — e mais uma rejeição no
 * histórico da WABA da campanha. (Backstop em zernio-template-validation.)
 */
export const zernioTemplateCategoryEnum = z.enum(['MARKETING', 'UTILITY']);

export const createZernioTemplateSchema = z.object({
  /** O canal (WABA) — obrigatório: o catálogo do Zernio é POR conta. */
  channelId: z.string().min(1),
  /** `^[a-z][a-z0-9_]*$` (validado na validação pura, com mensagem PT-BR). */
  name: z.string(),
  language: z.string().min(2).default('pt_BR'),
  category: zernioTemplateCategoryEnum.default('MARKETING'),
  body: z.string(),
  /** Amostras posicionais ({{1}} → [0]). A Meta rejeita `{{n}}` sem `example`. */
  bodyExamples: z.array(z.string()).default([]),
  footer: z.string().optional(),
  buttons: z.array(zernioTemplateButtonSchema).default([]),
});

export type CreateZernioTemplate = z.infer<typeof createZernioTemplateSchema>;

/**
 * PATCH /templates/:id/consent-buttons — a declaração de papel dos botões de um
 * template IMPORTADO do painel do Zernio (o sync não pode inventá-la: do rótulo
 * sozinho é indecidível se "Bora, quero!" é um botão comum ou o "sim" de um
 * opt-in cujos cliques iriam todos para o lixo).
 *
 * O `text` casa com o rótulo QUE A META TEM (o service confere) e a coerência do
 * papel com o reconhecedor é validada lá — aqui vive só o SHAPE.
 */
export const declareConsentButtonsSchema = z.object({
  buttons: z
    .array(
      z.object({
        text: z.string().min(1),
        role: zernioButtonRoleEnum,
      }),
    )
    .min(1),
});
export type DeclareConsentButtons = z.infer<typeof declareConsentButtonsSchema>;

export const updateTemplateSchema = z.object({
  language: z.string().min(2).optional(),
  body: z.string().min(1).optional(),
  category: templateCategoryEnum.optional(),
  status: templateStatusEnum.optional(),
  kind: templateKindSchema.optional(),
  interactiveConfig: z.unknown().nullable().optional(),
  twilioContentSid: z
    .string()
    .regex(twilioContentSidRegex, 'Content SID inválido (HX…)')
    .nullable()
    .optional(),
  // Cross-field consistency (provider vs twilioContentSid) is validated in
  // TemplatesService.update against the EFFECTIVE (merged with existing row)
  // values — a partial update can't be checked in isolation the way create
  // can, mirroring how interactiveConfig is validated for updates.
  provider: channelProviderEnum.optional(),
});

// ── Twilio Content templates (twilio-platform T4) ───────────────────────────
// Contratos de REQUEST de POST /templates/twilio e PATCH /templates/:id/
// twilio-draft, espelhando os content types suportados do dossiê §3.1:
// twilio/text, twilio/media, twilio/quick-reply, twilio/call-to-action.
// O RESPONSE dos três endpoints Twilio (create/submit/draft) é o row Template
// (templateSchema acima). Aqui vive só o SHAPE — limites de caracteres e
// regras de variáveis ficam na validação pura agregada em PT-BR
// (modules/templates/twilio-template-validation.ts), para reportar TODOS os
// problemas de uma vez.

export const twilioContentTypeEnum = z.enum([
  'twilio/text',
  'twilio/media',
  'twilio/quick-reply',
  'twilio/call-to-action',
]);
export type TwilioContentTypeContract = z.infer<typeof twilioContentTypeEnum>;

/** twilio/quick-reply: `id` volta no webhook inbound como ButtonPayload. */
export const twilioQuickReplyActionSchema = z.object({
  title: z.string(),
  id: z.string(),
});

/**
 * twilio/call-to-action: `PHONE_NUMBER` é o valor real da Content API (o
 * dossiê abrevia "PHONE"); `url` obrigatória p/ URL e `phone` p/ PHONE_NUMBER
 * são exigidas pela validação pura (mensagem PT-BR agregada).
 */
export const twilioCtaActionSchema = z.object({
  type: z.enum(['URL', 'PHONE_NUMBER']),
  title: z.string(),
  url: z.string().optional(),
  phone: z.string().optional(),
});

export const twilioTemplateActionSchema = z.union([
  twilioQuickReplyActionSchema,
  twilioCtaActionSchema,
]);

export const createTwilioTemplateSchema = z.object({
  /**
   * Nome de aprovação (`^[a-z0-9_]+$`, ≤512 — validação pura) — vira o
   * `metaName` local e o `friendly_name`/`name` na Twilio.
   */
  name: z.string(),
  language: z.string().min(2).default('pt_BR'),
  // MARKETING é o default do orgamind: campanhas frias caem nessa categoria
  // (dossiê §3.1); UTILITY fica para transações iniciadas pelo usuário.
  category: templateCategoryEnum.default('MARKETING'),
  contentType: twilioContentTypeEnum,
  body: z.string(),
  /** Amostras por variável (`{"1":"João"}`) — obrigatórias p/ aprovação. */
  variables: z.record(z.string(), z.string()).default({}),
  /** twilio/media: URLs públicas https. */
  media: z.array(z.string()).optional(),
  /** twilio/quick-reply ({title,id}) ou twilio/call-to-action ({type,…}). */
  actions: z.array(twilioTemplateActionSchema).optional(),
});

/**
 * PATCH /templates/:id/twilio-draft — mesmo shape sem `name`: o nome do
 * rascunho é imutável no orgamind (é a chave `metaName` local e o `name` de
 * aprovação; renomear = criar outro template).
 */
export const updateTwilioDraftSchema = createTwilioTemplateSchema.omit({
  name: true,
});

export type CreateTwilioTemplate = z.infer<typeof createTwilioTemplateSchema>;
export type UpdateTwilioDraft = z.infer<typeof updateTwilioDraftSchema>;

/** Query params for `GET /templates` — optionally filter by provider. */
export const listTemplatesQuerySchema = z.object({
  provider: channelProviderEnum.optional(),
});

export type Template = z.infer<typeof templateSchema>;
export type CreateTemplate = z.infer<typeof createTemplateSchema>;
export type UpdateTemplate = z.infer<typeof updateTemplateSchema>;
export type ListTemplatesQuery = z.infer<typeof listTemplatesQuerySchema>;
