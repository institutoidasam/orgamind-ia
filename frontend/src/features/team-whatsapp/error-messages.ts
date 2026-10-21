import type { DispatchRecipient } from './schemas';

export const PACING_HINT =
  'Os envios saem aos poucos, no ritmo do canal; para um setor grande pode levar alguns minutos.';

export const TARGETS_ERROR_MESSAGE = 'Não foi possível carregar os canais.';

const FALLBACK_MESSAGE = 'Não foi possível enviar a mensagem.';

const TEAM_ERROR_MESSAGES: Record<string, string> = {
  'team_whatsapp.forbidden': 'Você não tem permissão para enviar a este destino.',
  'team_whatsapp.channel_disconnected':
    'O canal escolhido está desconectado. Reconecte o número ou escolha outro canal.',
  'team_whatsapp.channel_invalid': 'Canal inválido: escolha um canal GoZap ou Evolution ativo.',
  'team_whatsapp.no_recipients': 'Ninguém neste destino tem telefone válido para receber.',
  'team_whatsapp.invalid_selection':
    'A lista de pessoas mudou. Atualize a página e confira de novo.',
};

export const SKIP_REASON_LABEL = {
  NO_PHONE: 'sem telefone',
  SUPPRESSED: 'pediu para não receber (SAIR)',
} as const;

/** Mensagem PT-BR para o código de erro da API do WhatsApp da equipe. */
export function teamErrorMessage(code?: string): string {
  return (code && TEAM_ERROR_MESSAGES[code]) || FALLBACK_MESSAGE;
}

const DISCONNECTED_CODES = new Set([
  'evolution.session_closed', 'evolution.not_connected', 'evolution.session_unstable',
  'gozap.not_connected', 'team_whatsapp.channel_disconnected',
]);
const INVALID_NUMBER_CODES = new Set([
  'evolution.number_not_on_whatsapp', 'gozap.not_on_whatsapp', 'gozap.invalid_recipient',
]);
const UNCONFIRMED_CODES = new Set([
  'evolution.unknown', 'gozap.unknown', 'gozap.indeterminate', 'team_whatsapp.indeterminate',
]);
const RATE_LIMIT_CODES = new Set(['evolution.rate_limited', 'gozap.quota_exceeded']);
const UNAVAILABLE_CODES = new Set([
  'evolution.unreachable', 'evolution.unauthorized', 'evolution.provider_unauthorized',
  'gozap.unreachable', 'gozap.unauthorized', 'gozap.no_token', 'team_whatsapp.queue_unavailable',
]);

/** Texto PT-BR, orientado à ação do operador, para o `errorCode` de uma falha de envio. */
export function failureReasonLabel(code: string | null): string {
  if (code === null) return 'Falha no envio';
  if (DISCONNECTED_CODES.has(code)) return 'Canal desconectado — reconecte em Números e canais';
  if (code === 'team_whatsapp.channel_invalid') {
    return 'Canal removido ou inválido — escolha outro canal';
  }
  if (INVALID_NUMBER_CODES.has(code)) {
    return 'Número sem WhatsApp ou inválido — confira o telefone no cadastro';
  }
  if (code.endsWith('.timeout') || UNCONFIRMED_CODES.has(code)) {
    return 'Sem confirmação do WhatsApp — confira no celular antes de reenviar';
  }
  if (RATE_LIMIT_CODES.has(code)) return 'Limite de envios do canal atingido — tente mais tarde';
  if (UNAVAILABLE_CODES.has(code)) return 'Serviço de WhatsApp indisponível — avise o administrador';
  return `Falha no envio (código ${code})`;
}

/** Situação de um destinatário: falha usa failureReasonLabel; pulo, SKIP_REASON_LABEL. */
export function recipientStatusLabel(r: Pick<DispatchRecipient, 'status' | 'reason'>): string {
  if (r.status === 'QUEUED') return 'Na fila';
  if (r.status === 'SENT') return 'Enviado';
  if (r.status === 'FAILED') return `Falhou: ${failureReasonLabel(r.reason)}`;
  const skip = r.reason && (SKIP_REASON_LABEL as Record<string, string>)[r.reason];
  return skip ? `Pulado: ${skip}` : 'Pulado';
}
