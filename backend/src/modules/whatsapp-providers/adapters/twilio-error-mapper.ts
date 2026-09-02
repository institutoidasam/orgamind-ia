/**
 * Classifies Twilio (WhatsApp) error codes into a stable category so the send
 * pipeline knows whether to (a) fail fast vs. retry, and (b) auto-opt-out the
 * contact. Twilio returns numeric application error codes (distinct from the
 * HTTP status); we key off those.
 *
 * Why this exists: without it EVERY Twilio error is non-fatal (WhatsappSendError
 * defaults fatal=false) and there is no Twilio code in the Meta-only fatal set,
 * so a permanently-invalid number (21211) or a not-a-WhatsApp-user (63003) burns
 * all 5 BullMQ retries before FAILED — wasting the daily tier budget and Twilio
 * quota that the valid contacts need. It also lets the webhook path and the send
 * path agree on which codes mean "the recipient opted out".
 */
export type TwilioErrorCategory = {
  /** Stable code stored on Message.errorCode (falls back to the raw Twilio code). */
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
 * Per-code rules. Codes not listed here default to non-fatal (retryable) so a
 * transient/unknown error still rides out the retry budget rather than being
 * permanently failed on a guess.
 */
const RULES: Record<string, Rule> = {
  // ── Permanent recipient/address problems (fail fast) ──────────────────────
  '21211': {
    fatal: true,
    optedOut: false,
    message: 'Número inválido (formato E.164 incorreto). Corrija o contato.',
  },
  '21408': {
    fatal: true,
    optedOut: false,
    message:
      'Permissão para enviar a esta região não está habilitada na conta Twilio.',
  },
  '21612': {
    fatal: true,
    optedOut: false,
    message: 'Número não está acessível pelo WhatsApp no momento.',
  },
  '63003': {
    fatal: true,
    optedOut: false,
    message: 'Destinatário não é um usuário do WhatsApp.',
  },
  '63005': {
    fatal: true,
    optedOut: false,
    message: 'O WhatsApp recusou o conteúdo da mensagem.',
  },
  '63007': {
    fatal: true,
    optedOut: false,
    message:
      'Remetente WhatsApp (From) não encontrado na Twilio — verifique o número/registro do sender.',
  },
  '63013': {
    fatal: true,
    optedOut: false,
    message:
      'Mensagem viola a política do WhatsApp/Meta. Revise o template/conteúdo.',
  },
  '63016': {
    fatal: true,
    optedOut: false,
    message:
      'Mensagem livre fora da janela de 24h — é necessário um template aprovado.',
  },
  '63021': {
    fatal: true,
    optedOut: false,
    message: 'A Meta bloqueou o conteúdo desta mensagem.',
  },

  // ── Template pausado/desativado (T8) — fatal; exige ação no catálogo ──────
  '63040': {
    fatal: true,
    optedOut: false,
    message:
      'Template não pôde ser usado (pausado/desativado ou não aprovado). Sincronize o catálogo e use um template APROVADO.',
  },
  '63041': {
    fatal: true,
    optedOut: false,
    message:
      'Template PAUSADO pela Meta (feedback negativo dos usuários). Envio bloqueado até a Meta reativar — considere criar uma variação.',
  },
  '63042': {
    fatal: true,
    optedOut: false,
    message:
      'Template DESATIVADO pela Meta. Crie e aprove um novo template para continuar enviando.',
  },

  // ── C2: família 13xxxx — erros da META que a Twilio apenas REPASSA ────────
  // (spec §5). Até aqui NENHUM 13xxxx estava mapeado: todos caíam no default
  // *retryable*. Na prática o orgamind retentava 5x uma mensagem que a Meta havia
  // derrubado por template pausado (132015) e queimava retries num destinatário
  // que já estourou o cap de marketing (131049) — que é exatamente o que a Meta
  // pune ("further delivery attempts to these users may be unavailable for up
  // to 24 hours"). Os códigos abaixo espelham o zernio-error-mapper (mesma WABA
  // da Meta por trás), acrescidos de 131049.

  // Template pacing/pausa: a Meta segura as mensagens de um template novo ou sem
  // rating GREEN; se o feedback for ruim, o template vira PAUSED e cada mensagem
  // retida é DERRUBADA com 132015. É decisão sobre o TEMPLATE INTEIRO — retentar
  // não muda nada e o kill-switch dispara no PRIMEIRO evento (limiar 1).
  '132015': {
    fatal: true,
    optedOut: false,
    message:
      'Template pausado pela Meta por baixa qualidade (template pacing) — campanha abortada. Não adianta retentar: revise/substitua o template.',
  },
  '132016': {
    fatal: true,
    optedOut: false,
    message:
      'Template DESATIVADO pela Meta. Crie e aprove um novo template para continuar enviando.',
  },
  // Cap adaptativo de templates de MARKETING por destinatário em 24h, somando
  // TODAS as empresas. Fatal NESTA mensagem (é falha do destinatário, não do
  // template) e reenvio proibido antes de 24h — o processor grava um bloqueio em
  // Redis para o número, justamente para não queimar retries.
  '131049': {
    fatal: true,
    optedOut: false,
    message:
      'A Meta não entregou: o destinatário atingiu o limite diário de mensagens de marketing (somando todas as empresas). Reenvio bloqueado por 24h.',
  },
  '131021': {
    fatal: true,
    optedOut: false,
    message:
      'Destinatário inválido: o número não é um usuário do WhatsApp (ou é igual ao remetente).',
  },
  '131026': {
    fatal: true,
    optedOut: false,
    message:
      'Mensagem não entregável (janela expirada / re-engajamento necessário) — use um template aprovado.',
  },
  '131031': {
    fatal: true,
    optedOut: false,
    message: 'Número/conta bloqueado pela Meta (suspenso). Verifique a WABA.',
  },
  '131047': {
    fatal: true,
    optedOut: false,
    message:
      'Fora da janela de 24h — é necessário um template aprovado para reabrir a conversa.',
  },
  '131051': {
    fatal: true,
    optedOut: false,
    message: 'Tipo de mensagem não suportado pela Meta para este envio.',
  },
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
  '133010': {
    fatal: true,
    optedOut: false,
    message:
      'Número remetente não registrado na Cloud API da Meta. Conclua o registro do número.',
  },
  // Transientes da família 13xxxx.
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
  // Usuário parou de receber MARKETING desta empresa (equivalente Meta do
  // 63032): fatal + opt-out.
  '131050': {
    fatal: true,
    optedOut: true,
    message:
      'Destinatário optou por não receber mensagens de marketing. Marcado como opt-out.',
  },

  // ── Opt-out / blocked recipient (fail fast + flag opt-out) ────────────────
  '21610': {
    fatal: true,
    optedOut: true,
    message:
      'Destinatário pediu para não receber mensagens (STOP/opt-out). Envio bloqueado.',
  },
  '63020': {
    fatal: true,
    optedOut: true,
    message:
      'Destinatário bloqueou/optou por sair. Marcado como opt-out.',
  },
  '63024': {
    fatal: true,
    optedOut: true,
    message:
      'A Meta recusou a entrega (usuário pode ter bloqueado o número). Marcado como opt-out.',
  },
  // T8 — usuário limitou o recebimento de MARKETING (Meta 472): fatal por
  // destinatário + flag no contato (higiene de lista; retry só desperdiça
  // cota de tier).
  '63032': {
    fatal: true,
    optedOut: true,
    message:
      'Usuário limitou o recebimento de mensagens de marketing no WhatsApp. Marcado como opt-out.',
  },

  // ── Transient (retry) ─────────────────────────────────────────────────────
  '20429': {
    fatal: false,
    optedOut: false,
    message: 'Rate limit da API Twilio — retentando.',
  },
  '429': {
    fatal: false,
    optedOut: false,
    message: 'Rate limit da API Twilio — retentando.',
  },
  '63018': {
    fatal: false,
    optedOut: false,
    message:
      'Limite de taxa do canal WhatsApp excedido (throughput/tier) — retentando na próxima janela.',
  },
  // T8 — limite diário da CONTA Twilio em janela móvel de 24h (trial: 50/dia).
  '63038': {
    fatal: false,
    optedOut: false,
    message:
      'Limite diário de mensagens da conta Twilio excedido (janela de 24h) — retentando após a janela.',
  },
  // T8 — Meta limitou a entrega de MARKETING (throttle por baixo engajamento
  // previsto). Transiente: retry com atraso progressivo; consecutivos contam
  // para o kill-switch de campanha.
  '63049': {
    fatal: false,
    optedOut: false,
    message:
      'A Meta limitou a entrega de mensagens de marketing (baixo engajamento previsto) — retentando com atraso.',
  },
  '30001': {
    fatal: false,
    optedOut: false,
    message: 'Fila da Twilio cheia — retentando.',
  },
  '20003': {
    fatal: false,
    optedOut: false,
    message:
      'Falha de autenticação com a Twilio (token inválido/rotacionado?) — retentando.',
  },

  // ── Client-side timeout: unknown whether Twilio accepted (indeterminate).
  // The processor treats this specially (does NOT resend) to avoid double
  // charges; classified non-fatal here only for completeness.
  'twilio.timeout': {
    fatal: false,
    optedOut: false,
    message:
      'Timeout ao falar com a Twilio — status indeterminado, aguardando reconciliação.',
  },
};

export function classifyTwilioError(
  code: string | undefined,
  providerMessage?: string,
): TwilioErrorCategory {
  const rule = code ? RULES[code] : undefined;
  if (rule) {
    return {
      code: code as string,
      message: rule.message,
      fatal: rule.fatal,
      optedOut: rule.optedOut,
    };
  }
  // Unknown/unclassified: retryable, keep whatever detail Twilio gave.
  return {
    code: code ?? 'twilio.unknown',
    message:
      providerMessage && providerMessage.trim().length > 0
        ? providerMessage
        : 'Falha desconhecida no envio via Twilio.',
    fatal: false,
    optedOut: false,
  };
}

/** Codes that mean "the recipient opted out" — shared by the webhook path. */
export function isTwilioOptOutCode(code: string | undefined): boolean {
  return !!code && RULES[code]?.optedOut === true;
}

/**
 * T8 — códigos de template/qualidade que alimentam o kill-switch de campanha:
 * quando ocorrem CONSECUTIVAMENTE numa campanha, o restante do lote vai falhar
 * igual (template pausado/desativado, throttle de marketing por engajamento,
 * lista sem opt-in) — continuar só queima cota e quality rating.
 * 63024/63032/131049 ficam de fora: são problemas do DESTINATÁRIO individual,
 * não do template/campanha.
 *
 * C2 — o conjunto vale para TODOS os provedores cloud (TWILIO/META/ZERNIO): os
 * 63xxx são da Twilio (e simplesmente nunca ocorrem nos outros), enquanto os
 * 13xxxx vêm da Meta e podem chegar por qualquer um deles.
 */
const KILL_SWITCH_CODES = new Set([
  '63040',
  '63041',
  '63042',
  '63049',
  '21610',
  '132015',
  '132016',
  // ZA3 — 131031: a Meta BLOQUEOU a conta/número (suspensão da WABA). Não é
  // falha de destinatário nem de template: é a conta inteira. Cada envio
  // seguinte é mais uma rejeição no histórico de qualidade do número.
  '131031',
]);

export function isTwilioKillSwitchCode(code: string | undefined): boolean {
  return !!code && KILL_SWITCH_CODES.has(code);
}

/**
 * C2 (spec §5.3) — códigos que disparam o kill-switch com LIMIAR 1, e não 5.
 *
 * 132015 não é a falha de um destinatário: é a Meta decidindo pausar o TEMPLATE
 * INTEIRO (template pacing). A segunda ocorrência já é desperdício de cota e de
 * quality rating — o limiar de 5 consecutivos, correto para 63040/63041, aqui
 * só serve para queimar mais mensagens depois de a decisão já ter sido tomada.
 *
 * ZA3 — 131031 (conta bloqueada/restrita pela Meta) entra pelo mesmo motivo,
 * ainda mais forte: nenhuma mensagem daquela conta vai sair, e insistir só
 * acumula rejeição no histórico do número.
 */
const IMMEDIATE_KILL_SWITCH_CODES = new Set(['132015', '131031']);

export function isImmediateKillSwitchCode(code: string | undefined): boolean {
  return !!code && IMMEDIATE_KILL_SWITCH_CODES.has(code);
}

/**
 * ZA3 — códigos que significam "a META pausou ESTE TEMPLATE", e só eles podem
 * refletir PAUSED no catálogo local.
 *
 * Separado de {@link isImmediateKillSwitchCode} de propósito: o 131031 também
 * cancela a campanha na primeira ocorrência, mas quem está bloqueado é a CONTA
 * — marcar o template como PAUSED seria culpar o inocente e tirá-lo do gate de
 * campanha (que só aceita APPROVED) por um problema que não é dele.
 */
const TEMPLATE_PAUSING_CODES = new Set(['132015']);

export function pausesTemplateLocally(code: string | undefined): boolean {
  return !!code && TEMPLATE_PAUSING_CODES.has(code);
}
