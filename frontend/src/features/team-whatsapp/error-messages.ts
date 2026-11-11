import { readApiErrorBody } from '@/lib/api-error';
import type { DispatchCounts, RecipientStatus } from './schemas';

export const PACING_HINT =
  'Os envios saem aos poucos, no ritmo do canal; para um setor grande pode levar alguns minutos.';

const FALLBACK_MESSAGE = 'Não foi possível enviar a mensagem.';
const CANCEL_FALLBACK_MESSAGE = 'Não foi possível cancelar o envio. Tente de novo.';
const RETRY_FALLBACK_MESSAGE = 'Não foi possível repetir o envio. Tente de novo.';

const TEAM_ERROR_MESSAGES: Record<string, string> = {
  'team_whatsapp.forbidden': 'Você não tem permissão para enviar a este destino.',
  'team_whatsapp.sector_without_number':
    'Há área sem número neste envio. Associe um número a ela em Conexões.',
  'team_whatsapp.no_sector': 'Esta pessoa não tem área. Coloque-a num setor antes de enviar.',
  'team_whatsapp.channel_disconnected':
    'Um número deste envio está desconectado. Veja na prévia qual é.',
  'team_whatsapp.channel_unverified': 'Não foi possível conferir o número. Tente de novo',
  'team_whatsapp.no_recipients': 'Ninguém neste destino tem telefone válido para receber.',
  'team_whatsapp.invalid_selection':
    'A lista de pessoas mudou. Atualize a página e confira de novo.',
  'team_whatsapp.invalid_level': 'Nível inválido. Atualize a página e tente de novo.',
  'team_whatsapp.invalid_shift': 'Este turno não está mais disponível. Atualize a página.',
  'team_whatsapp.schedule_in_past': 'O início deste turno já passou. Escolha Enviar agora ou outra data.',
  'team_whatsapp.not_cancellable': 'Este envio já saiu ou foi cancelado.',
  'team_whatsapp.dispatch_not_found': 'Envio não encontrado. Atualize a página.',
  'team_whatsapp.too_many_people': 'Os setores escolhidos têm mais de 2000 pessoas. Escolha menos setores.',
};

export const SKIP_REASON_LABEL = {
  NO_PHONE: 'sem telefone',
  SUPPRESSED: 'pediu para não receber (SAIR)',
  INACTIVE: 'Usuário inativo',
} as const;

/** Motivo de a pessoa estar fora da escala do dia (grupo "De folga"). */
export const OFF_REASON_LABEL = { DAY_OFF: 'Folga', VACATION: 'Férias' } as const;

/** Mensagem PT-BR para o código de erro da API do WhatsApp da equipe. */
export function teamErrorMessage(code?: string): string {
  return (code && TEAM_ERROR_MESSAGES[code]) || FALLBACK_MESSAGE;
}

/** Como teamErrorMessage, mas o erro não mapeado fala do cancelamento, não do envio. */
export function cancelErrorMessage(code?: string): string {
  return (code && TEAM_ERROR_MESSAGES[code]) || CANCEL_FALLBACK_MESSAGE;
}

/** Como teamErrorMessage, mas o erro não mapeado fala da repetição, não do envio. */
export function retryErrorMessage(code?: string): string {
  return (code && TEAM_ERROR_MESSAGES[code]) || RETRY_FALLBACK_MESSAGE;
}

/** `code` do corpo de erro da API (ex.: 'team_whatsapp.not_cancellable'), se houver. */
export async function apiErrorCode(err: unknown): Promise<string | undefined> {
  return (await readApiErrorBody(err))?.code;
}

const DISCONNECTED_CODES = new Set([
  'evolution.session_closed', 'evolution.not_connected', 'evolution.session_unstable',
  'gozap.not_connected', 'team_whatsapp.channel_disconnected',
]);
const INVALID_NUMBER_CODES = new Set([
  'evolution.number_not_on_whatsapp', 'gozap.not_on_whatsapp', 'gozap.invalid_recipient',
]);
const UNCONFIRMED_CODES = new Set([
  'evolution.unknown', 'gozap.indeterminate', 'team_whatsapp.indeterminate',
]);
const RATE_LIMIT_CODES = new Set(['evolution.rate_limited', 'gozap.quota_exceeded']);
const UNAVAILABLE_CODES = new Set([
  'evolution.unreachable', 'evolution.unauthorized', 'evolution.provider_unauthorized',
  'gozap.unreachable', 'gozap.unauthorized', 'gozap.no_token', 'gozap.unknown', 'team_whatsapp.queue_unavailable',
]);

/** Motivos de falha ligados ao número da área (GC11). */
const CHANNEL_REASON_LABEL = new Map([
  ['team_whatsapp.channel_unverified', 'Não foi possível conferir o número'],
  ['team_whatsapp.channel_unavailable', 'Número indisponível na hora do envio'],
  ['team_whatsapp.channel_invalid', 'Número removido ou inválido'],
]);

/** Texto PT-BR, orientado à ação do operador, para o `errorCode` de uma falha de envio. */
export function failureReasonLabel(code: string | null): string {
  if (code === null) return 'Falha no envio';
  if (DISCONNECTED_CODES.has(code)) return 'Número desconectado';
  const channelReason = CHANNEL_REASON_LABEL.get(code);
  if (channelReason) return channelReason;
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

/** Situação de um destinatário, sem o motivo (GC11). `FAILED` e `SKIPPED` ganham `: <motivo>` abaixo. */
export const RECIPIENT_STATUS_LABEL = {
  QUEUED: 'Na fila',
  SENT: 'Aceito pelo WhatsApp',
  DELIVERED: 'Entregue',
  READ: 'Lido',
  REPLIED: 'Respondeu',
  FAILED: 'Falhou',
  UNCERTAIN: 'Situação incerta',
  SKIPPED: 'Pulado',
  SCHEDULED: 'Agendado',
  CANCELLED: 'Cancelado',
} as const satisfies Record<RecipientStatus, string>;

/** Situação de um destinatário: falha usa failureReasonLabel; pulo, SKIP_REASON_LABEL. */
export function recipientStatusLabel(status: RecipientStatus, reason: string | null): string {
  if (status === 'FAILED') return `${RECIPIENT_STATUS_LABEL.FAILED}: ${failureReasonLabel(reason)}`;
  if (status !== 'SKIPPED') return RECIPIENT_STATUS_LABEL[status];
  const skip = reason && (SKIP_REASON_LABEL as Record<string, string>)[reason];
  return skip ? `${RECIPIENT_STATUS_LABEL.SKIPPED}: ${skip}` : RECIPIENT_STATUS_LABEL.SKIPPED;
}

/** Ordem em que as contagens aparecem: a do ciclo do envio (GC11). */
const COUNT_ORDER: [keyof DispatchCounts, RecipientStatus][] = [
  ['queued', 'QUEUED'], ['sent', 'SENT'], ['delivered', 'DELIVERED'], ['read', 'READ'], ['replied', 'REPLIED'],
  ['failed', 'FAILED'], ['uncertain', 'UNCERTAIN'], ['skipped', 'SKIPPED'], ['scheduled', 'SCHEDULED'],
  ['cancelled', 'CANCELLED'],
];

/** Só as situações com alguém, na ordem do ciclo: `{ status: 'SENT', label: 'Aceito pelo WhatsApp', count: 3 }`. */
export function countParts(counts: DispatchCounts): { status: RecipientStatus; label: string; count: number }[] {
  return COUNT_ORDER.filter(([key]) => counts[key] > 0).map(([key, status]) => ({
    status,
    label: RECIPIENT_STATUS_LABEL[status],
    count: counts[key],
  }));
}

/** Explicação da situação incerta (GC11): sem botão, porque a mensagem pode ter saído. */
export const UNCERTAIN_EXPLANATION =
  'O WhatsApp não confirmou o envio. A mensagem pode ter saído: confira no celular antes de mandar de novo.';

/** Número como a lista de conexões mostra (`phoneE164` cru); sem telefone, o nome; sem nenhum, removido. */
export function channelLabel(
  { phoneE164, name }: { phoneE164: string | null; name: string | null },
  withCount: number | null = null,
): string {
  const label = phoneE164 ?? name ?? 'Número removido';
  return withCount === null ? label : `${label} (${withCount})`;
}
