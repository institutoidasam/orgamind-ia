import type { CommunicationDetail } from './schemas';

export function isViewer(role?: string) { return role === 'VIEWER'; }

export function personName(person: CommunicationDetail['author'] | undefined) {
  return person?.name || person?.email || 'Usuário removido';
}

export function dateTime(value?: string | null) {
  return value
    ? new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Manaus' }).format(new Date(value))
    : '—';
}

export function eventText(kind: string, message?: string | null) {
  if (message) return message;
  return ({ CREATED: 'abriu a comunicação', COMMENTED: 'adicionou uma atualização', STATUS_CHANGED: 'alterou a situação', ASSIGNED: 'atribuiu um responsável', UNASSIGNED: 'removeu o responsável', PRIORITY_CHANGED: 'alterou a prioridade', DUE_DATE_CHANGED: 'alterou o prazo' }[kind] ?? 'atualizou a comunicação');
}

export function civilDate(value?: string | null) { return value ? new Intl.DateTimeFormat('pt-BR', { timeZone: 'UTC' }).format(new Date(`${value}T00:00:00Z`)) : '—'; }

export function demandUpdateErrorMessage(error: unknown) {
  const status = typeof error === 'object' && error !== null && 'response' in error
    ? (error as { response?: { status?: number } }).response?.status
    : undefined;
  return status === 409
    ? 'Esta demanda foi alterada por outra pessoa. Atualize os dados antes de tentar novamente.'
    : 'Não foi possível salvar a alteração. Tente novamente.';
}
