/**
 * Validação PRÉ-Twilio de templates (twilio-platform T4).
 *
 * Regras de nome/variáveis/limites que a Meta usa para rejeitar templates —
 * validadas ANTES de chamar a Content API, agregando TODOS os problemas em
 * PT-BR de uma vez (não só o primeiro), para o operador corrigir tudo num
 * único round-trip. Fonte: docs/superpowers/specs/2026-07-10-twilio-whatsapp-
 * capabilities.md §3.1.
 *
 * Função pura (sem I/O) — testável isoladamente e reutilizável pelo form do
 * frontend via espelhamento das mensagens.
 */

export type TwilioContentTypeName =
  | 'twilio/text'
  | 'twilio/media'
  | 'twilio/quick-reply'
  | 'twilio/call-to-action';

export type TwilioQuickReplyActionInput = {
  /** Rótulo do botão (máx. 20 chars). */
  title: string;
  /** Payload estável entregue no webhook como ButtonPayload (máx. 200). */
  id: string;
};

export type TwilioCtaActionInput = {
  /**
   * `PHONE_NUMBER` é o valor aceito pela Content API (o dossiê §3.1 abrevia
   * como "PHONE", mas o shape real do twilio/call-to-action usa PHONE_NUMBER).
   */
  type: 'URL' | 'PHONE_NUMBER';
  title: string;
  url?: string;
  phone?: string;
};

export type TwilioTemplateValidationInput = {
  /** Nome de aprovação (também usado como friendly_name): ^[a-z0-9_]+$. */
  name: string;
  body: string;
  /** Amostras por variável, ex. `{"1":"João"}` — obrigatórias p/ aprovação. */
  variables?: Record<string, string>;
  contentType: TwilioContentTypeName;
  /** twilio/media: URLs públicas https. */
  media?: string[];
  /** twilio/quick-reply ou twilio/call-to-action. */
  actions?: Array<TwilioQuickReplyActionInput | TwilioCtaActionInput>;
};

const APPROVAL_NAME_REGEX = /^[a-z0-9_]+$/;
const APPROVAL_NAME_MAX = 512;
/** E.164: + seguido de 2 a 15 dígitos, sem zero à esquerda. */
const E164_REGEX = /^\+[1-9]\d{1,14}$/;
/** Token de variável `{{...}}` sem espaço interno (mesma regra do runtime). */
const VARIABLE_TOKEN_REGEX = /\{\{([^}\s]+)\}\}/g;

const QUICK_REPLY_TITLE_MAX = 20;
const QUICK_REPLY_ID_MAX = 200;
const QUICK_REPLY_MAX_ACTIONS = 10;
const CTA_TITLE_MAX = 20;
const CTA_MAX_URL_ACTIONS = 2;
const CTA_MAX_PHONE_ACTIONS = 1;

/** Limite de caracteres do body por content type (dossiê §3.1). */
export const TWILIO_BODY_LIMITS: Record<TwilioContentTypeName, number> = {
  'twilio/text': 1600,
  'twilio/media': 1600,
  'twilio/quick-reply': 1024,
  'twilio/call-to-action': 640,
};

/**
 * Valida o input de criação/edição de template Twilio. Retorna a lista de
 * TODOS os problemas encontrados (PT-BR); lista vazia = válido.
 */
export function validateTwilioTemplateInput(
  input: TwilioTemplateValidationInput,
): string[] {
  const problems: string[] = [];
  validateApprovalName(input.name, problems);
  validateBody(input, problems);
  validateByContentType(input, problems);
  return problems;
}

/**
 * Monta o objeto `types` da Content API a partir do input validado — o shape
 * exato enviado no POST /v1/Content (e persistido em `interactiveConfig` para
 * types não-texto, mantendo o row local fiel ao que vive na Twilio).
 */
export function buildTwilioContentTypes(
  input: Omit<TwilioTemplateValidationInput, 'name'>,
): Record<string, unknown> {
  switch (input.contentType) {
    case 'twilio/text':
      return { 'twilio/text': { body: input.body } };
    case 'twilio/media':
      return {
        'twilio/media': { body: input.body, media: input.media ?? [] },
      };
    case 'twilio/quick-reply':
      return {
        'twilio/quick-reply': {
          body: input.body,
          actions: ((input.actions ?? []) as TwilioQuickReplyActionInput[]).map(
            (a) => ({ title: a.title, id: a.id }),
          ),
        },
      };
    case 'twilio/call-to-action':
      return {
        'twilio/call-to-action': {
          body: input.body,
          actions: ((input.actions ?? []) as TwilioCtaActionInput[]).map(
            (a) => ({
              type: a.type,
              title: a.title,
              ...(a.url !== undefined && { url: a.url }),
              ...(a.phone !== undefined && { phone: a.phone }),
            }),
          ),
        },
      };
  }
}

function validateApprovalName(name: string, problems: string[]): void {
  if (!name) {
    problems.push('Nome de aprovação é obrigatório.');
    return;
  }
  if (name.length > APPROVAL_NAME_MAX) {
    problems.push(
      `Nome de aprovação excede ${APPROVAL_NAME_MAX} caracteres (atual: ${name.length}).`,
    );
  }
  if (!APPROVAL_NAME_REGEX.test(name)) {
    problems.push(
      'Nome de aprovação inválido: use apenas letras minúsculas, números e underscore (_).',
    );
  }
}

function validateBody(
  input: TwilioTemplateValidationInput,
  problems: string[],
): void {
  const { body, contentType } = input;
  if (!body) {
    problems.push('O corpo do template é obrigatório.');
    return;
  }

  const limit = TWILIO_BODY_LIMITS[contentType];
  if (body.length > limit) {
    problems.push(
      `O corpo excede o limite de ${limit} caracteres do tipo ${contentType} (atual: ${body.length}).`,
    );
  }

  const tokens = [...body.matchAll(VARIABLE_TOKEN_REGEX)].map((m) => m[1]);

  const nonNumeric = [...new Set(tokens.filter((t) => !/^\d+$/.test(t)))];
  if (nonNumeric.length > 0) {
    problems.push(
      `Variáveis do corpo devem ser numéricas ({{1}}, {{2}}, …) — inválidas: ${nonNumeric
        .map((t) => `{{${t}}}`)
        .join(', ')}.`,
    );
  }

  const numbers = [
    ...new Set(tokens.filter((t) => /^\d+$/.test(t)).map(Number)),
  ].sort((a, b) => a - b);
  const sequential = numbers.every((n, i) => n === i + 1);
  if (!sequential) {
    problems.push(
      `Variáveis do corpo devem ser sequenciais a partir de {{1}} — encontradas: ${numbers
        .map((n) => `{{${n}}}`)
        .join(', ')}.`,
    );
  }

  if (/^\s*\{\{[^}\s]+\}\}/.test(body)) {
    problems.push('O corpo não pode começar com uma variável.');
  }
  if (/\{\{[^}\s]+\}\}\s*$/.test(body)) {
    problems.push('O corpo não pode terminar com uma variável.');
  }
  // Só a adjacência DIRETA ({{1}}{{2}}) é bloqueada; {{1}} {{2}} é aceito.
  if (/\}\}\{\{/.test(body)) {
    problems.push(
      'Variáveis adjacentes sem texto entre elas não são permitidas (ex.: {{1}}{{2}}).',
    );
  }

  validateSamples(input, tokens, problems);
}

/**
 * Toda variável usada (no corpo e nas URLs de CTA — a Twilio permite variável
 * no fim da URL) precisa de amostra em `variables` para a aprovação da Meta.
 */
function validateSamples(
  input: TwilioTemplateValidationInput,
  bodyTokens: string[],
  problems: string[],
): void {
  const used = new Set(bodyTokens);
  if (input.contentType === 'twilio/call-to-action') {
    for (const action of (input.actions ?? []) as TwilioCtaActionInput[]) {
      for (const m of (action.url ?? '').matchAll(VARIABLE_TOKEN_REGEX)) {
        used.add(m[1]);
      }
    }
  }
  const samples = input.variables ?? {};
  const missing = [...used].filter((v) => !(v in samples));
  if (missing.length > 0) {
    problems.push(
      `Faltam amostras para as variáveis: ${missing
        .map((v) => `{{${v}}}`)
        .join(', ')} — informe um valor de exemplo para cada uma.`,
    );
  }
}

function validateByContentType(
  input: TwilioTemplateValidationInput,
  problems: string[],
): void {
  switch (input.contentType) {
    case 'twilio/text':
      return;
    case 'twilio/media':
      return validateMedia(input.media, problems);
    case 'twilio/quick-reply':
      return validateQuickReplyActions(
        (input.actions ?? []) as TwilioQuickReplyActionInput[],
        problems,
      );
    case 'twilio/call-to-action':
      return validateCtaActions(
        (input.actions ?? []) as TwilioCtaActionInput[],
        problems,
      );
  }
}

function validateMedia(media: string[] | undefined, problems: string[]): void {
  if (!media || media.length === 0) {
    problems.push('twilio/media exige ao menos uma URL de mídia.');
    return;
  }
  for (const url of media) {
    if (!url.startsWith('https://')) {
      problems.push(`URL de mídia deve usar https:// — inválida: "${url}".`);
    }
  }
}

function validateQuickReplyActions(
  actions: TwilioQuickReplyActionInput[],
  problems: string[],
): void {
  if (actions.length === 0) {
    problems.push('twilio/quick-reply exige ao menos um botão.');
    return;
  }
  if (actions.length > QUICK_REPLY_MAX_ACTIONS) {
    problems.push(
      `twilio/quick-reply permite no máximo ${QUICK_REPLY_MAX_ACTIONS} botões (recebidos: ${actions.length}).`,
    );
  }
  actions.forEach((action, index) => {
    const n = index + 1;
    if (!action.title) {
      problems.push(`Botão ${n}: título é obrigatório.`);
    } else if (action.title.length > QUICK_REPLY_TITLE_MAX) {
      problems.push(
        `Botão ${n}: título excede ${QUICK_REPLY_TITLE_MAX} caracteres (atual: ${action.title.length}).`,
      );
    }
    if (!action.id) {
      problems.push(`Botão ${n}: id (payload) é obrigatório.`);
    } else if (action.id.length > QUICK_REPLY_ID_MAX) {
      problems.push(
        `Botão ${n}: id (payload) excede ${QUICK_REPLY_ID_MAX} caracteres (atual: ${action.id.length}).`,
      );
    }
  });
}

function validateCtaActions(
  actions: TwilioCtaActionInput[],
  problems: string[],
): void {
  if (actions.length === 0) {
    problems.push('twilio/call-to-action exige ao menos um botão.');
    return;
  }
  const urlCount = actions.filter((a) => a.type === 'URL').length;
  if (urlCount > CTA_MAX_URL_ACTIONS) {
    problems.push(
      `twilio/call-to-action permite no máximo ${CTA_MAX_URL_ACTIONS} botões URL (recebidos: ${urlCount}).`,
    );
  }
  const phoneCount = actions.filter((a) => a.type === 'PHONE_NUMBER').length;
  if (phoneCount > CTA_MAX_PHONE_ACTIONS) {
    problems.push(
      `twilio/call-to-action permite no máximo ${CTA_MAX_PHONE_ACTIONS} botão de telefone (recebidos: ${phoneCount}).`,
    );
  }
  actions.forEach((action, index) => {
    const n = index + 1;
    if (!action.title) {
      problems.push(`Botão ${n}: título é obrigatório.`);
    } else if (action.title.length > CTA_TITLE_MAX) {
      problems.push(
        `Botão ${n}: título excede ${CTA_TITLE_MAX} caracteres (atual: ${action.title.length}).`,
      );
    }
    if (action.type === 'URL' && !(action.url ?? '').startsWith('https://')) {
      problems.push(`Botão ${n}: url deve usar https://.`);
    }
    if (action.type === 'PHONE_NUMBER' && !E164_REGEX.test(action.phone ?? '')) {
      problems.push(
        `Botão ${n}: telefone deve estar em formato E.164 (ex.: +5592999999999).`,
      );
    }
  });
}
