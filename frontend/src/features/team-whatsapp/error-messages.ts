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
};

export const SKIP_REASON_LABEL = {
  NO_PHONE: 'sem telefone',
  SUPPRESSED: 'pediu para não receber (SAIR)',
} as const;

/** Mensagem PT-BR para o código de erro da API do WhatsApp da equipe. */
export function teamErrorMessage(code?: string): string {
  return (code && TEAM_ERROR_MESSAGES[code]) || FALLBACK_MESSAGE;
}
