import { z } from 'zod';
import { FailureReason } from '@prisma/client';

// `optedOut` is intentionally absent from the rule fields the operator can
// build filters on. Until 2026-08-25 this comment said the exclusion was
// "enforced unconditionally in toPrismaWhere" — that stopped being true that
// day: the client asked for opt-out contacts to stop being auto-excluded from
// the CAMPAIGN audience (preview/creation/batches/segments), so
// `filter.converter.ts#toPrismaWhere` no longer embeds `{ optedOut: false }`
// (see the comment there for the full decision). The field stays out of this
// enum simply because no one asked for a rule that filters BY opt-out status
// here. The actual opt-out protection now lives downstream, per consumer:
// dispatch time (`CampaignsService#dispatchAudience`, `send-message.processor.ts`,
// `zernio-broadcast-send.service.ts`) for sends, and locally inside
// `ConsentBulkGrantService#resolve` (consent-bulk-grant.service.ts) for bulk
// consent grants — not in this shared contract or in toPrismaWhere anymore.
const fieldSchema = z.enum([
  'name',
  'city',
  'group',
  'phoneE164',
  'tags',
  'whatsappValid',
  // B.4 — o motivo da última falha DEFINITIVA (Contact.lastFailureReason), a
  // outra metade de "inválido confirmado". Sem ele o assistente não consegue
  // expressar "não mande para quem o WhatsApp já recusou".
  'lastFailureReason',
]);
const opSchema = z.enum([
  'eq',
  'ne',
  'contains',
  'startsWith',
  'endsWith',
  'in',
  'notIn',
  'isNull',
  'notNull',
]);

export type Rule = {
  field:
    | 'name'
    | 'city'
    | 'group'
    | 'phoneE164'
    | 'tags'
    | 'whatsappValid'
    | 'lastFailureReason';
  op:
    | 'eq'
    | 'ne'
    | 'contains'
    | 'startsWith'
    | 'endsWith'
    | 'in'
    | 'notIn'
    | 'isNull'
    | 'notNull';
  value?: string | number | boolean | string[];
};

export type FilterGroup = {
  combinator: 'and' | 'or';
  rules: Array<Rule | HistoryRule | FilterGroup>;
};

// Ops that require NO value (presence checks).
const NULLARY_OPS = new Set(['isNull', 'notNull']);
// Ops whose value must be a string array.
const ARRAY_OPS = new Set(['in', 'notIn']);
// Ops whose value must be a plain string (substring/affix matching). These map
// to Prisma `contains`/`startsWith`/`endsWith` (and `tags has`) — all of which
// require a string at the DB layer.
const STRING_OPS = new Set(['contains', 'startsWith', 'endsWith']);

export const ruleSchema: z.ZodType<Rule> = z
  .object({
    field: fieldSchema,
    op: opSchema,
    value: z
      .union([z.string(), z.number(), z.boolean(), z.array(z.string())])
      .optional(),
  })
  // Restrict op/value pairs so a malformed rule can never produce an invalid
  // Prisma `where` that 500s the (scheduled) dispatch path. Without this,
  // e.g. { field:'name', op:'in', value:'x' } becomes { name: { in: 'x' } },
  // which Prisma rejects at query time — crashing the worker run.
  .superRefine((rule, ctx) => {
    const { field, op, value } = rule;

    const fail = (message: string) =>
      ctx.addIssue({ code: 'custom', message, path: ['value'] });

    // ── whatsappValid is a boolean column: only equality checks make sense. ──
    if (field === 'whatsappValid') {
      if (op === 'isNull' || op === 'notNull') {
        if (value !== undefined) fail(`op "${op}" must not carry a value`);
        return;
      }
      if (op !== 'eq' && op !== 'ne') {
        fail(`whatsappValid only supports eq/ne/isNull/notNull (got "${op}")`);
        return;
      }
      if (typeof value !== 'boolean') {
        fail('whatsappValid eq/ne requires a boolean value');
      }
      return;
    }

    // ── lastFailureReason é uma coluna de ENUM: só presença e pertinência. ──
    // `contains`/`startsWith` num enum produzem filtro Prisma inválido, e
    // `eq/ne` escalares abririam a porta para o valor de um enum inexistente.
    if (field === 'lastFailureReason') {
      if (op === 'isNull' || op === 'notNull') {
        if (value !== undefined) fail(`op "${op}" must not carry a value`);
        return;
      }
      if (op !== 'in' && op !== 'notIn') {
        fail(
          `lastFailureReason only supports in/notIn/isNull/notNull (got "${op}")`,
        );
        return;
      }
      if (!Array.isArray(value) || value.length === 0) {
        fail(`op "${op}" requires a non-empty array value`);
        return;
      }
      const known = new Set<string>(Object.values(FailureReason));
      const unknown = value.filter((v) => !known.has(v));
      if (unknown.length > 0) {
        fail(
          `lastFailureReason values outside FailureReason: ${unknown.join(', ')}`,
        );
      }
      return;
    }

    // ── Presence checks take no value. ──────────────────────────────────────
    if (NULLARY_OPS.has(op)) {
      if (value !== undefined) fail(`op "${op}" must not carry a value`);
      return;
    }

    // ── in / notIn require a (string) array. ────────────────────────────────
    if (ARRAY_OPS.has(op)) {
      if (!Array.isArray(value)) fail(`op "${op}" requires an array value`);
      return;
    }

    // ── contains / startsWith / endsWith require a string. ──────────────────
    if (STRING_OPS.has(op)) {
      if (typeof value !== 'string') {
        fail(`op "${op}" requires a string value`);
      }
      return;
    }

    // ── eq / ne: any scalar is fine, but a value must be present. ───────────
    if (op === 'eq' || op === 'ne') {
      if (value === undefined) fail(`op "${op}" requires a value`);
      // eq/ne are scalar equality: an array value maps to an invalid Prisma
      // filter (e.g. { name: ['a','b'] }) that 500s the dispatch path.
      if (Array.isArray(value)) fail(`op "${op}" requires a scalar value`);
      // `tags` is a string[] column: scalar equality on it is meaningless and
      // produces an invalid Prisma filter — only `contains` (has) is supported.
      if (field === 'tags') {
        fail('tags only supports the "contains" operator');
      }
    }
  });

export type HistoryRule = {
  kind: 'history';
  event: 'received' | 'failed' | 'replied';
  negate: boolean;
  campaignIds?: string[];
  templateIds?: string[];
  failureReason?: FailureReason;
};

export const historyRuleSchema: z.ZodType<HistoryRule> = z
  .object({
    kind: z.literal('history'),
    event: z.enum(['received', 'failed', 'replied']),
    negate: z.boolean(),
    campaignIds: z.array(z.string().min(1)).max(100).optional(),
    templateIds: z.array(z.string().min(1)).max(100).optional(),
    // F2 T5: tightened from F1's z.string().min(1) to z.nativeEnum — a
    // failureReason outside the 11 FailureReason values (or an empty string,
    // which isn't a member either) never identifies a real failure.
    failureReason: z.nativeEnum(FailureReason).optional(),
  })
  // Restrições globais §48: um nó de histórico sem alvo (nenhuma campanha ou
  // template) casaria com "qualquer envio", o que silenciosamente vira um
  // filtro vazio (ou universal) em toPrismaWhere — nunca o que o operador quis
  // dizer. failureReason só faz sentido quando o evento é uma falha; nos
  // outros eventos ele é um campo órfão que não tem contrapartida no Prisma.
  .superRefine((rule, ctx) => {
    const hasCampaigns = (rule.campaignIds?.length ?? 0) > 0;
    const hasTemplates = (rule.templateIds?.length ?? 0) > 0;

    if (!hasCampaigns && !hasTemplates) {
      // Médio (review F1 T2): emitir SÓ em `path:['campaignIds']` fixava a
      // culpa nesse campo mesmo quando foi templateIds que o operador tentou
      // preencher (e errou) — o front não tinha como saber em qual dos dois
      // campos desenhar o erro. Emitir um addIssue por campo (mesma
      // mensagem) deixa os dois inputs marcáveis, espelhando o padrão já
      // usado em templates/schemas.ts para "um dos dois campos exige o
      // outro" (dois .refine, cada um com seu próprio `path`).
      const message =
        'history rule requires a non-empty target: at least one of campaignIds/templateIds';
      ctx.addIssue({ code: 'custom', message, path: ['campaignIds'] });
      ctx.addIssue({ code: 'custom', message, path: ['templateIds'] });
    }

    if (rule.failureReason !== undefined && rule.event !== 'failed') {
      ctx.addIssue({
        code: 'custom',
        message: 'failureReason is only allowed when event is "failed"',
        path: ['failureReason'],
      });
    }
  });

export const filterGroupSchema: z.ZodType<FilterGroup> = z.object({
  combinator: z.enum(['and', 'or']),
  rules: z.array(
    z.union([ruleSchema, historyRuleSchema, z.lazy(() => filterGroupSchema)]),
  ),
});
