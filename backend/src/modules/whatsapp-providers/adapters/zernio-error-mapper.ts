/**
 * Classifies Zernio errors into a stable category so the send pipeline knows
 * whether to (a) fail fast vs. retry, and (b) auto-opt-out the contact. Mirrors
 * {@link ../adapters/twilio-error-mapper} (classifyTwilioError / isTwilioOptOutCode).
 *
 * Zernio's error envelope is `{ error, type, code, param, docUrl }` where `type`
 * is a coarse category (`invalid_request_error`, `rate_limit_error`, …) and
 * `code` is a stable machine-readable code. When the failure came from the
 * upstream provider (Meta), Zernio wraps it as `type: "platform_error"` with a
 * nested `platformError` carrying the WhatsApp Cloud API numeric code (e.g.
 * `132001` template not found). The adapter extracts the most specific code it
 * can (Meta code > Zernio code > HTTP status) and passes it here.
 *
 * Why this exists: WhatsappSendError defaults fatal=false, so without this every
 * Zernio error would burn all BullMQ retries — wasting the daily Meta tier
 * budget on permanently-invalid numbers / unapproved templates / disconnected
 * accounts. It also lets the webhook path and the send path agree on which codes
 * mean "the recipient opted out".
 */
export type ZernioErrorCategory = {
  /** Stable code stored on Message.errorCode (falls back to the raw code/type). */
  code: string;
  /** Operator-facing reason in Portuguese. */
  message: string;
  /** true → mark FAILED immediately, skip the BullMQ retries. */
  fatal: boolean;
  /** true → the recipient is unsubscribed/blocked; flag contact.optedOut. */
  optedOut: boolean;
};

type Rule = { fatal: boolean; optedOut: boolean; message: string };

/**
 * Per-code rules keyed by Zernio `code`, Meta Cloud API numeric code, or an
 * HTTP status string. Anything not listed defaults to non-fatal (retryable) so a
 * transient/unknown error rides the retry budget instead of being permanently
 * failed on a guess.
 */
const RULES: Record<string, Rule> = {
  // ── Fatal: invalid recipient ──────────────────────────────────────────────
  '131021': {
    fatal: true,
    optedOut: false,
    message: 'Destinatário inválido: o número não é um usuário do WhatsApp.',
  },
  // ZE — 131026 na prática é MARKETING DESLIGADO pelo destinatário. Medido ao
  // vivo num broadcast real de 120: 37 falhas (30% da base), 36 delas 131026. O
  // texto da Meta é "Message undeliverable" + "the recipient has likely TURNED
  // OFF MARKETING MESSAGES". É definitivo para MARKETING — o contato é marcado
  // como inalcançável (Contact.marketingUndeliverableAt) e não volta a entrar em
  // lote de campanha MARKETING. Ver marketing-reachability.ts.
  '131026': {
    fatal: true,
    optedOut: false,
    message:
      'Mensagem não entregável: o destinatário provavelmente DESLIGOU as mensagens de marketing no WhatsApp. Templates UTILITY continuam funcionando.',
  },
  // ZE — 130472: "part of a marketing-message experiment, cannot receive
  // marketing templates right now. UTILITY TEMPLATES ARE NOT AFFECTED." (Meta).
  //
  // Sem esta regra o código caía no DEFAULT (retryable) e queimava as 5
  // tentativas do BullMQ + cota do tier contra uma parede — a Meta não vai
  // entregar um template de MARKETING a este usuário por mais que se insista.
  // Fatal, e a mensagem diz a saída real (UTILITY).
  '130472': {
    fatal: true,
    optedOut: false,
    message:
      'A Meta não entrega templates de MARKETING a este destinatário agora (ele está num experimento de mensagens de marketing). Templates UTILITY não são afetados.',
  },
  invalid_field_value: {
    fatal: true,
    optedOut: false,
    message: 'Valor de campo inválido (ex.: telefone do destinatário). Corrija o contato.',
  },

  // ── Fatal: template not approved / missing / malformed ────────────────────
  '132000': {
    fatal: true,
    optedOut: false,
    message:
      'Número de variáveis do template não confere com o template aprovado.',
  },
  '132001': {
    fatal: true,
    optedOut: false,
    message: 'Template não encontrado ou não aprovado para este número.',
  },
  '132005': {
    fatal: true,
    optedOut: false,
    message:
      'Texto do template excede o tamanho permitido após preencher as variáveis.',
  },
  // Template paused / disabled by Meta due to low quality — fatal (retrying
  // won't help until the template recovers or is replaced).
  '132015': {
    fatal: true,
    optedOut: false,
    message: 'Template pausado pela Meta por baixa qualidade. Revise o template.',
  },
  '132016': {
    fatal: true,
    optedOut: false,
    message: 'Template desativado pela Meta. Escolha outro template.',
  },
  '132007': {
    fatal: true,
    optedOut: false,
    message: 'Conteúdo do template viola a política da Meta. Revise o template.',
  },
  '132012': {
    fatal: true,
    optedOut: false,
    message: 'Formato de parâmetro do template inválido.',
  },
  template_required: {
    fatal: true,
    optedOut: false,
    message:
      'É necessário um template aprovado para iniciar/reabrir a conversa (fora da janela de 24h).',
  },

  // ── Fatal: account disconnected / plan / bad request ──────────────────────
  linked_account_required: {
    fatal: true,
    optedOut: false,
    message:
      'Conta WhatsApp desconectada no Zernio — reconecte o número (accountId) para enviar.',
  },
  account_not_found: {
    fatal: true,
    optedOut: false,
    message: 'Conta (accountId) não encontrada ou inacessível no Zernio.',
  },
  missing_required_field: {
    fatal: true,
    optedOut: false,
    message: 'Campo obrigatório ausente na requisição ao Zernio.',
  },
  mutually_exclusive_fields: {
    fatal: true,
    optedOut: false,
    message: 'Campos mutuamente exclusivos enviados juntos ao Zernio.',
  },
  invalid_json_body: {
    fatal: true,
    optedOut: false,
    message: 'Corpo JSON inválido na requisição ao Zernio.',
  },
  feature_not_available: {
    fatal: true,
    optedOut: false,
    message: 'Recurso indisponível no plano atual do Zernio (upgrade necessário).',
  },

  // ── Fatal: auth / entitlement (NUNCA retentar) ────────────────────────────
  // Sem estas duas regras o default (retryable) transformava uma chave revogada
  // ou um add-on cancelado em RETRY INFINITO, queimando o balde de rate limit
  // (60 req/min no tier atual) e travando a fila inteira. Nenhum retry conserta
  // credencial inválida nem assinatura suspensa — falhe rápido e avise o humano.
  //
  // A Zernio responde 401 com um corpo nu (`{"error":"Unauthorized"}`, sem
  // `code`/`type`), então o adapter cai para o STATUS HTTP como código: são
  // estas chaves ('401'/'403') que capturam o caso real.
  '401': {
    fatal: true,
    optedOut: false,
    message:
      'Zernio rejeitou a credencial (401): chave de API inválida, revogada ou rotacionada. Envio interrompido — atualize ZERNIO_API_KEY.',
  },
  '403': {
    fatal: true,
    optedOut: false,
    message:
      'Zernio negou o acesso (403): o add-on de Inbox da workspace pode ter sido cancelado, o limite de perfis estourado ou a assinatura suspensa. Envio interrompido — verifique a assinatura/plano da workspace Zernio.',
  },

  // ── Fatal: number suspended / account blocked ─────────────────────────────
  '131031': {
    fatal: true,
    optedOut: false,
    message: 'Número/conta bloqueado pela Meta (suspenso). Verifique a WABA.',
  },

  // ── C2: cap de MARKETING por destinatário (spec §5.3) ─────────────────────
  // Cada usuário tem um teto adaptativo de templates de marketing por 24h,
  // somando TODAS as empresas. Fatal NESTA mensagem — é falha do DESTINATÁRIO,
  // não do template: não marca opt-out e não alimenta o kill-switch. Reenviar
  // antes de 24h PIORA (a Meta pode suspender a entrega ao usuário), então o
  // processor grava um bloqueio de 24h para o número em Redis.
  '131049': {
    fatal: true,
    optedOut: false,
    message:
      'A Meta não entregou: o destinatário atingiu o limite diário de mensagens de marketing (somando todas as empresas). Reenvio bloqueado por 24h.',
  },

  // ── Opt-out / blocked recipient (fail fast + flag opt-out) ────────────────
  '131050': {
    fatal: true,
    optedOut: true,
    message:
      'Destinatário optou por não receber mensagens (marketing). Marcado como opt-out.',
  },
  recipient_opted_out: {
    fatal: true,
    optedOut: true,
    message: 'Destinatário cancelou o recebimento. Marcado como opt-out.',
  },

  // ── Transient (retry) ─────────────────────────────────────────────────────
  rate_limited: {
    fatal: false,
    optedOut: false,
    message: 'Rate limit do Zernio — retentando.',
  },
  '429': {
    fatal: false,
    optedOut: false,
    message: 'Rate limit do Zernio — retentando.',
  },
  // Re-engagement message outside the 24h window — retrying the free-form send
  // won't help; a template is required. Fatal, not transient.
  '131047': {
    fatal: true,
    optedOut: false,
    message:
      'Fora da janela de 24h — é necessário um template aprovado para reabrir a conversa.',
  },
  '131048': {
    fatal: false,
    optedOut: false,
    message: 'Limite de taxa (anti-spam) da Meta — retentando na próxima janela.',
  },
  '131052': {
    fatal: false,
    optedOut: false,
    message: 'Falha ao baixar a mídia do template — retentando.',
  },
  internal_error: {
    fatal: false,
    optedOut: false,
    message: 'Erro interno do Zernio — retentando com backoff.',
  },
  '500': {
    fatal: false,
    optedOut: false,
    message: 'Erro interno do Zernio (500) — retentando com backoff.',
  },
  '502': {
    fatal: false,
    optedOut: false,
    message: 'Zernio/upstream indisponível (502) — retentando.',
  },
  '503': {
    fatal: false,
    optedOut: false,
    message: 'Zernio indisponível (503) — retentando.',
  },

  // ── Client-side network failures (indeterminate/transient) ────────────────
  'zernio.timeout': {
    fatal: false,
    optedOut: false,
    message:
      'Timeout ao falar com o Zernio — status indeterminado, aguardando reconciliação.',
  },
  'zernio.unreachable': {
    fatal: false,
    optedOut: false,
    message: 'Zernio inacessível — retentando.',
  },
};

/**
 * Fallback rules keyed by the coarse Zernio `type`, consulted only when `code`
 * is unknown.
 *
 * Auth errors are FATAL here, deliberately. Treating them as transient (the
 * previous behaviour, borrowed from Twilio's `20003`) means a revoked key or a
 * cancelled Inbox add-on retries forever — and because the orgamind key is an
 * INVITED user on the client's Zernio workspace, that is a failure mode the
 * IDASAM does not control and cannot fix by waiting. Retrying it only burns the
 * 60 req/min bucket that the campaign itself needs.
 */
const TYPE_RULES: Record<string, Rule> = {
  invalid_request_error: {
    fatal: true,
    optedOut: false,
    message: 'Requisição inválida ao Zernio (não será reenviada).',
  },
  permission_error: {
    fatal: true,
    optedOut: false,
    message: 'Permissão negada no Zernio (plano/add-on necessário).',
  },
  not_found: {
    fatal: true,
    optedOut: false,
    message: 'Recurso não encontrado no Zernio.',
  },
  authentication_error: {
    fatal: true,
    optedOut: false,
    message:
      'Falha de autenticação com o Zernio (chave inválida/revogada/rotacionada). Envio interrompido — atualize ZERNIO_API_KEY.',
  },
  rate_limit_error: {
    fatal: false,
    optedOut: false,
    message: 'Rate limit do Zernio — retentando.',
  },
  api_error: {
    fatal: false,
    optedOut: false,
    message: 'Erro do servidor Zernio — retentando com backoff.',
  },
};

export function classifyZernioError(
  code: string | undefined,
  type?: string,
  providerMessage?: string,
): ZernioErrorCategory {
  const byCode = code ? RULES[code] : undefined;
  const byType = !byCode && type ? TYPE_RULES[type] : undefined;
  const rule = byCode ?? byType;
  const resolvedCode = code ?? type ?? 'zernio.unknown';
  if (rule) {
    return {
      code: resolvedCode,
      message: rule.message,
      fatal: rule.fatal,
      optedOut: rule.optedOut,
    };
  }
  // Unknown/unclassified: retryable, keep whatever detail Zernio gave.
  return {
    code: resolvedCode,
    message:
      providerMessage && providerMessage.trim().length > 0
        ? providerMessage
        : 'Falha desconhecida no envio via Zernio.',
    fatal: false,
    optedOut: false,
  };
}

/** Codes that mean "the recipient opted out" — shared by the webhook path. */
export function isZernioOptOutCode(code: string | undefined): boolean {
  return !!code && RULES[code]?.optedOut === true;
}
