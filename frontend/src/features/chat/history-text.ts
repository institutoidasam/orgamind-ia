import type { ConversationHistoryItem } from './schemas';

/** Rodapé da lista quando o servidor devolveu só as 200 linhas mais recentes (DK19, M8). */
export const HISTORY_TRUNCATED_TEXT = 'Mostrando as 200 mudanças mais recentes.';

const SYSTEM_LABEL = 'Sistema';
const REMOVED_USER_LABEL = 'Usuário removido';

type Parts = { actor: string; from: string | null; to: string | null; system: boolean };

/** Pessoa da linha: nome; id sem nome = usuário removido; sem id nem nome = ausente. */
function person(id: string | null, name: string | null): string | null {
  if (name) return name;
  return id ? REMOVED_USER_LABEL : null;
}

const withFrom = (from: string | null) => (from ? ` de ${from}` : '');
const withTo = (to: string | null) => (to ? ` para ${to}` : '');

const LINE_BY_ACTION: Record<ConversationHistoryItem['action'], (p: Parts) => string> = {
  ASSUMED: (p) => `${p.actor} assumiu a conversa`,
  ASSUMED_ON_REPLY: (p) => `${p.actor} assumiu ao responder`,
  TRANSFERRED: (p) => `${p.actor} transferiu${withFrom(p.from)}${withTo(p.to)}`,
  UNASSIGNED: (p) => `${p.actor} removeu o atendente${p.from ? ` ${p.from}` : ''}`,
  RESOLVED: (p) => `${p.actor} resolveu a conversa`,
  REOPENED: (p) => (p.system ? `${SYSTEM_LABEL} reabriu a conversa (nova mensagem recebida)` : `${p.actor} reabriu a conversa`),
  SHIFT_HANDOVER: (p) => `${p.actor} passou o turno${withFrom(p.from)}${withTo(p.to)}`,
};

/** Texto da mudança (sem a hora): autor nulo = "Sistema"; id sem nome = "Usuário removido". */
export function historyLine(item: ConversationHistoryItem): string {
  const system = item.actorId === null;
  const actor = system ? SYSTEM_LABEL : (item.actorName ?? REMOVED_USER_LABEL);
  const from = person(item.fromUserId, item.fromUserName);
  const to = person(item.toUserId, item.toUserName);
  return LINE_BY_ACTION[item.action]({ actor, from, to, system });
}

/** Dia, mês, hora e minuto em Manaus (UTC-4, sem horário de verão); o front não faz conta de fuso. */
const MANAUS_PARTS = new Intl.DateTimeFormat('pt-BR', {
  timeZone: 'America/Manaus',
  day: '2-digit',
  month: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** 'dd/MM HH:mm' de um instante ISO, na hora de Manaus. */
export function historyTime(iso: string): string {
  const parts: Record<string, string> = {};
  for (const p of MANAUS_PARTS.formatToParts(new Date(iso))) parts[p.type] = p.value;
  return `${parts.day}/${parts.month} ${parts.hour}:${parts.minute}`;
}
