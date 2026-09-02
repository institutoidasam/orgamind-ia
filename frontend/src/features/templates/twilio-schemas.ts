// twilio-platform T5 — schema do form "Novo template Twilio" (Content API).
//
// Espelha os contratos do backend (backend/src/schemas/contracts/
// template.schema.ts) e a validação pura agregada em PT-BR (backend/src/
// modules/templates/twilio-template-validation.ts): as MENSAGENS daqui são as
// mesmas do backend sempre que a regra é a mesma, para o operador ver o mesmo
// texto inline antes do request sair — o backend continua sendo o backstop.
import { z } from 'zod';
import { templateCategoryEnum, type Template } from './schemas';

export const TWILIO_CONTENT_TYPES = [
  'twilio/text',
  'twilio/media',
  'twilio/quick-reply',
  'twilio/call-to-action',
] as const;
export type TwilioContentType = (typeof TWILIO_CONTENT_TYPES)[number];

export const TWILIO_CONTENT_TYPE_LABEL: Record<TwilioContentType, string> = {
  'twilio/text': 'Texto',
  'twilio/media': 'Mídia',
  'twilio/quick-reply': 'Botões de resposta rápida',
  'twilio/call-to-action': 'Call-to-action',
};

/** Limite de caracteres do body por content type (dossiê §3.1 — backend). */
export const TWILIO_BODY_LIMITS: Record<TwilioContentType, number> = {
  'twilio/text': 1600,
  'twilio/media': 1600,
  'twilio/quick-reply': 1024,
  'twilio/call-to-action': 640,
};

export const QUICK_REPLY_TITLE_MAX = 20;
export const QUICK_REPLY_ID_MAX = 200;
export const QUICK_REPLY_MAX_ACTIONS = 10;
export const CTA_TITLE_MAX = 20;
export const CTA_MAX_URL_ACTIONS = 2;
export const CTA_MAX_PHONE_ACTIONS = 1;

const APPROVAL_NAME_MAX = 512;
const APPROVAL_NAME_REGEX = /^[a-z0-9_]+$/;
/** E.164: + seguido de 2 a 15 dígitos, sem zero à esquerda (backend). */
const E164_REGEX = /^\+[1-9]\d{1,14}$/;
/** Token `{{...}}` sem espaço interno — mesma regra do runtime/backend. */
const VARIABLE_TOKEN_REGEX = /\{\{([^}\s]+)\}\}/g;

// ── Payload da API (request de POST /templates/twilio) ──────────────────────

export type TwilioQuickReplyAction = { title: string; id: string };
export type TwilioCtaAction = {
  /** `PHONE_NUMBER` é o valor real da Content API (não "PHONE"). */
  type: 'URL' | 'PHONE_NUMBER';
  title: string;
  url?: string;
  phone?: string;
};

export type CreateTwilioTemplateInput = {
  /** Nome de aprovação (`^[a-z0-9_]+$`) — vira o metaName local. */
  name: string;
  language: string;
  category: z.infer<typeof templateCategoryEnum>;
  contentType: TwilioContentType;
  body: string;
  /** Amostras por variável (`{"1":"João"}`) — obrigatórias p/ aprovação. */
  variables: Record<string, string>;
  /** twilio/media: URLs públicas https. */
  media?: string[];
  /** twilio/quick-reply ({title,id}) ou twilio/call-to-action ({type,…}). */
  actions?: Array<TwilioQuickReplyAction | TwilioCtaAction>;
};

/** PATCH /templates/:id/twilio-draft — mesmo shape sem `name` (imutável). */
export type UpdateTwilioDraftInput = Omit<CreateTwilioTemplateInput, 'name'>;

// ── Valores do form (react-hook-form) ────────────────────────────────────────
// Coleções ficam como arrays de objetos p/ useFieldArray; o payload da API é
// derivado por buildCreateTwilioTemplate.

const sampleSchema = z.object({
  variable: z.string(),
  value: z.string(),
});

export const twilioTemplateFormSchema = z
  .object({
    name: z
      .string()
      .min(1, 'Nome de aprovação é obrigatório.')
      .max(
        APPROVAL_NAME_MAX,
        `Nome de aprovação excede ${APPROVAL_NAME_MAX} caracteres.`,
      )
      .regex(
        APPROVAL_NAME_REGEX,
        'Nome de aprovação inválido: use apenas letras minúsculas, números e underscore (_).',
      ),
    language: z.string().min(2, 'Obrigatório'),
    category: templateCategoryEnum,
    contentType: z.enum(TWILIO_CONTENT_TYPES),
    body: z.string().min(1, 'O corpo do template é obrigatório.'),
    samples: z.array(sampleSchema),
    media: z.array(z.object({ url: z.string() })),
    quickReplies: z.array(z.object({ title: z.string(), id: z.string() })),
    ctaUrls: z.array(z.object({ title: z.string(), url: z.string() })),
    ctaPhones: z.array(z.object({ title: z.string(), phone: z.string() })),
  })
  .superRefine((v, ctx) => {
    validateBody(v, ctx);
    validateSamples(v, ctx);
    // Só a coleção do content type ATIVO é validada — sobras de um tipo
    // escolhido antes (e agora oculto no form) não podem travar o submit.
    if (v.contentType === 'twilio/media') validateMedia(v, ctx);
    if (v.contentType === 'twilio/quick-reply') validateQuickReplies(v, ctx);
    if (v.contentType === 'twilio/call-to-action') validateCta(v, ctx);
  });

export type TwilioTemplateFormValues = z.infer<typeof twilioTemplateFormSchema>;

/**
 * Variáveis numéricas usadas no body (e nas URLs de CTA — a Twilio permite
 * variável no fim da URL), deduplicadas e em ordem crescente. Tokens
 * não-numéricos são reportados como erro do body, não geram input de amostra.
 */
export function detectTwilioVariables(
  body: string,
  ctaUrls: string[] = [],
): string[] {
  const found = new Set<string>();
  for (const text of [body, ...ctaUrls]) {
    for (const m of text.matchAll(VARIABLE_TOKEN_REGEX)) {
      if (/^\d+$/.test(m[1])) found.add(m[1]);
    }
  }
  return [...found].sort((a, b) => Number(a) - Number(b));
}

/** Monta o request de POST /templates/twilio a partir dos valores do form. */
export function buildCreateTwilioTemplate(
  values: TwilioTemplateFormValues,
): CreateTwilioTemplateInput {
  const used = new Set(
    detectTwilioVariables(
      values.body,
      values.contentType === 'twilio/call-to-action'
        ? values.ctaUrls.map((a) => a.url)
        : [],
    ),
  );
  const variables = Object.fromEntries(
    values.samples
      .filter((s) => used.has(s.variable))
      .map((s) => [s.variable, s.value]),
  );
  return {
    name: values.name,
    language: values.language,
    category: values.category,
    contentType: values.contentType,
    body: values.body,
    variables,
    ...(values.contentType === 'twilio/media'
      ? { media: values.media.map((m) => m.url) }
      : {}),
    ...(values.contentType === 'twilio/quick-reply'
      ? {
          actions: values.quickReplies.map((a) => ({
            title: a.title,
            id: a.id,
          })),
        }
      : {}),
    ...(values.contentType === 'twilio/call-to-action'
      ? {
          actions: [
            ...values.ctaUrls.map(
              (a): TwilioCtaAction => ({
                type: 'URL',
                title: a.title,
                url: a.url,
              }),
            ),
            ...values.ctaPhones.map(
              (a): TwilioCtaAction => ({
                type: 'PHONE_NUMBER',
                title: a.title,
                phone: a.phone,
              }),
            ),
          ],
        }
      : {}),
  };
}

/**
 * Payload default de um botão quick-reply derivado do título: minúsculas sem
 * acentos, espaços viram `_` (ex.: "Sim, pode" → `sim_pode`). O operador pode
 * sobrescrever — depois disso o campo não é mais rederivado pelo form.
 */
export function deriveQuickReplyId(title: string): string {
  return title
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, QUICK_REPLY_ID_MAX);
}

/**
 * Body do preview estilo WhatsApp: substitui `{{n}}` pela amostra quando
 * preenchida; sem amostra o token fica visível (mostra o que falta).
 */
export function renderTwilioPreviewBody(
  body: string,
  samples: Array<{ variable: string; value: string }>,
): string {
  let out = body;
  for (const s of samples) {
    if (s.value.trim()) out = out.replaceAll(`{{${s.variable}}}`, s.value);
  }
  return out;
}

// ── Clonar-e-corrigir / editar rascunho (prefill a partir do row) ────────────

/**
 * Nome do clone: incrementa um sufixo `_vN` existente (`_v2` → `_v3`) ou
 * anexa `_v2` — template submetido é imutável na Twilio, então correção =
 * criar um NOVO draft com outro nome.
 */
export function bumpCloneName(name: string): string {
  const match = name.match(/_v(\d+)$/);
  if (!match) return `${name}_v2`;
  return name.replace(/_v\d+$/, `_v${Number(match[1]) + 1}`);
}

type StoredTwilioAction = {
  type?: string;
  title?: string;
  id?: string;
  url?: string;
  phone?: string;
};
type StoredTwilioContent = {
  body?: string;
  media?: string[];
  actions?: StoredTwilioAction[];
};

/**
 * Reconstrói os valores do form a partir de um row Template TWILIO. O
 * `interactiveConfig` guarda o shape EXATO enviado à Content API (round-trip
 * do backend), então o content type sai das chaves do config; text não tem
 * config. Amostras voltam VAZIAS: só as chaves das variáveis são persistidas
 * localmente — o operador informa novos exemplos.
 */
export function twilioPrefillFromTemplate(t: Template): TwilioTemplateFormValues {
  const cfg = (t.interactiveConfig ?? null) as Record<
    string,
    StoredTwilioContent
  > | null;
  const contentType: TwilioContentType =
    cfg && 'twilio/media' in cfg
      ? 'twilio/media'
      : cfg && 'twilio/quick-reply' in cfg
        ? 'twilio/quick-reply'
        : cfg && 'twilio/call-to-action' in cfg
          ? 'twilio/call-to-action'
          : 'twilio/text';
  const inner = cfg?.[contentType];
  const body = t.body || inner?.body || '';
  const actions = inner?.actions ?? [];

  const quickReplies =
    contentType === 'twilio/quick-reply'
      ? actions.map((a) => ({ title: a.title ?? '', id: a.id ?? '' }))
      : [];
  const ctaUrls =
    contentType === 'twilio/call-to-action'
      ? actions
          .filter((a) => a.type === 'URL')
          .map((a) => ({ title: a.title ?? '', url: a.url ?? '' }))
      : [];
  const ctaPhones =
    contentType === 'twilio/call-to-action'
      ? actions
          .filter((a) => a.type === 'PHONE_NUMBER')
          .map((a) => ({ title: a.title ?? '', phone: a.phone ?? '' }))
      : [];

  return {
    name: t.metaName,
    language: t.language,
    category: t.category,
    contentType,
    body,
    samples: detectTwilioVariables(
      body,
      ctaUrls.map((a) => a.url),
    ).map((v) => ({ variable: v, value: '' })),
    media: (inner?.media ?? []).map((url) => ({ url })),
    quickReplies,
    ctaUrls,
    ctaPhones,
  };
}

/** Prefill do fluxo "Clonar e corrigir": mesmos valores, nome `_v2`. */
export function cloneTwilioPrefill(t: Template): TwilioTemplateFormValues {
  const base = twilioPrefillFromTemplate(t);
  return { ...base, name: bumpCloneName(base.name) };
}

// ── Regras (mensagens espelhadas do backend) ─────────────────────────────────

function validateBody(v: TwilioTemplateFormValues, ctx: z.RefinementCtx): void {
  const { body, contentType } = v;
  if (!body) return; // `.min(1)` já reportou a obrigatoriedade

  const limit = TWILIO_BODY_LIMITS[contentType];
  if (body.length > limit) {
    ctx.addIssue({
      code: 'custom',
      path: ['body'],
      message: `O corpo excede o limite de ${limit} caracteres do tipo ${contentType} (atual: ${body.length}).`,
    });
  }

  const tokens = [...body.matchAll(VARIABLE_TOKEN_REGEX)].map((m) => m[1]);

  const nonNumeric = [...new Set(tokens.filter((t) => !/^\d+$/.test(t)))];
  if (nonNumeric.length > 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['body'],
      message: `Variáveis do corpo devem ser numéricas ({{1}}, {{2}}, …) — inválidas: ${nonNumeric
        .map((t) => `{{${t}}}`)
        .join(', ')}.`,
    });
  }

  const numbers = [
    ...new Set(tokens.filter((t) => /^\d+$/.test(t)).map(Number)),
  ].sort((a, b) => a - b);
  if (!numbers.every((n, i) => n === i + 1)) {
    ctx.addIssue({
      code: 'custom',
      path: ['body'],
      message: `Variáveis do corpo devem ser sequenciais a partir de {{1}} — encontradas: ${numbers
        .map((n) => `{{${n}}}`)
        .join(', ')}.`,
    });
  }

  if (/^\s*\{\{[^}\s]+\}\}/.test(body)) {
    ctx.addIssue({
      code: 'custom',
      path: ['body'],
      message: 'O corpo não pode começar com uma variável.',
    });
  }
  if (/\{\{[^}\s]+\}\}\s*$/.test(body)) {
    ctx.addIssue({
      code: 'custom',
      path: ['body'],
      message: 'O corpo não pode terminar com uma variável.',
    });
  }
  // Só a adjacência DIRETA ({{1}}{{2}}) é bloqueada; {{1}} {{2}} é aceita.
  if (/\}\}\{\{/.test(body)) {
    ctx.addIssue({
      code: 'custom',
      path: ['body'],
      message:
        'Variáveis adjacentes sem texto entre elas não são permitidas (ex.: {{1}}{{2}}).',
    });
  }
}

/**
 * Toda variável usada precisa de amostra p/ aprovação da Meta. O erro é
 * anexado AO INPUT da amostra (o form mantém uma row por variável detectada);
 * se a row ainda não existe (corrida do sync), cai no body como agregado.
 */
function validateSamples(
  v: TwilioTemplateFormValues,
  ctx: z.RefinementCtx,
): void {
  const used = detectTwilioVariables(
    v.body,
    v.contentType === 'twilio/call-to-action'
      ? v.ctaUrls.map((a) => a.url)
      : [],
  );
  const missingRows: string[] = [];
  for (const variable of used) {
    const index = v.samples.findIndex((s) => s.variable === variable);
    if (index === -1) {
      missingRows.push(variable);
      continue;
    }
    if (!v.samples[index].value.trim()) {
      ctx.addIssue({
        code: 'custom',
        path: ['samples', index, 'value'],
        message: `Amostra obrigatória para {{${variable}}} — informe um valor de exemplo.`,
      });
    }
  }
  if (missingRows.length > 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['body'],
      message: `Faltam amostras para as variáveis: ${missingRows
        .map((n) => `{{${n}}}`)
        .join(', ')} — informe um valor de exemplo para cada uma.`,
    });
  }
}

function validateMedia(
  v: TwilioTemplateFormValues,
  ctx: z.RefinementCtx,
): void {
  if (v.media.length === 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['media'],
      message: 'twilio/media exige ao menos uma URL de mídia.',
    });
    return;
  }
  v.media.forEach((m, index) => {
    if (!m.url.startsWith('https://')) {
      ctx.addIssue({
        code: 'custom',
        path: ['media', index, 'url'],
        message: 'URL de mídia deve usar https://.',
      });
    }
  });
}

function validateQuickReplies(
  v: TwilioTemplateFormValues,
  ctx: z.RefinementCtx,
): void {
  if (v.quickReplies.length === 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['quickReplies'],
      message: 'twilio/quick-reply exige ao menos um botão.',
    });
    return;
  }
  if (v.quickReplies.length > QUICK_REPLY_MAX_ACTIONS) {
    ctx.addIssue({
      code: 'custom',
      path: ['quickReplies'],
      message: `twilio/quick-reply permite no máximo ${QUICK_REPLY_MAX_ACTIONS} botões (recebidos: ${v.quickReplies.length}).`,
    });
  }
  v.quickReplies.forEach((action, index) => {
    if (!action.title) {
      ctx.addIssue({
        code: 'custom',
        path: ['quickReplies', index, 'title'],
        message: 'Título é obrigatório.',
      });
    } else if (action.title.length > QUICK_REPLY_TITLE_MAX) {
      ctx.addIssue({
        code: 'custom',
        path: ['quickReplies', index, 'title'],
        message: `Título excede ${QUICK_REPLY_TITLE_MAX} caracteres (atual: ${action.title.length}).`,
      });
    }
    if (!action.id) {
      ctx.addIssue({
        code: 'custom',
        path: ['quickReplies', index, 'id'],
        message: 'Id (payload) é obrigatório.',
      });
    } else if (action.id.length > QUICK_REPLY_ID_MAX) {
      ctx.addIssue({
        code: 'custom',
        path: ['quickReplies', index, 'id'],
        message: `Id (payload) excede ${QUICK_REPLY_ID_MAX} caracteres (atual: ${action.id.length}).`,
      });
    }
  });
}

function validateCta(v: TwilioTemplateFormValues, ctx: z.RefinementCtx): void {
  if (v.ctaUrls.length + v.ctaPhones.length === 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['ctaUrls'],
      message: 'twilio/call-to-action exige ao menos um botão.',
    });
    return;
  }
  // Backstops — a UI já desabilita o "adicionar" nos máximos.
  if (v.ctaUrls.length > CTA_MAX_URL_ACTIONS) {
    ctx.addIssue({
      code: 'custom',
      path: ['ctaUrls'],
      message: `twilio/call-to-action permite no máximo ${CTA_MAX_URL_ACTIONS} botões URL (recebidos: ${v.ctaUrls.length}).`,
    });
  }
  if (v.ctaPhones.length > CTA_MAX_PHONE_ACTIONS) {
    ctx.addIssue({
      code: 'custom',
      path: ['ctaPhones'],
      message: `twilio/call-to-action permite no máximo ${CTA_MAX_PHONE_ACTIONS} botão de telefone (recebidos: ${v.ctaPhones.length}).`,
    });
  }
  v.ctaUrls.forEach((action, index) => {
    validateCtaTitle(action.title, ['ctaUrls', index, 'title'], ctx);
    if (!action.url.startsWith('https://')) {
      ctx.addIssue({
        code: 'custom',
        path: ['ctaUrls', index, 'url'],
        message: 'URL deve usar https://.',
      });
    }
  });
  v.ctaPhones.forEach((action, index) => {
    validateCtaTitle(action.title, ['ctaPhones', index, 'title'], ctx);
    if (!E164_REGEX.test(action.phone)) {
      ctx.addIssue({
        code: 'custom',
        path: ['ctaPhones', index, 'phone'],
        message: 'Telefone deve estar em formato E.164 (ex.: +5592999999999).',
      });
    }
  });
}

function validateCtaTitle(
  title: string,
  path: Array<string | number>,
  ctx: z.RefinementCtx,
): void {
  if (!title) {
    ctx.addIssue({ code: 'custom', path, message: 'Título é obrigatório.' });
  } else if (title.length > CTA_TITLE_MAX) {
    ctx.addIssue({
      code: 'custom',
      path,
      message: `Título excede ${CTA_TITLE_MAX} caracteres (atual: ${title.length}).`,
    });
  }
}
