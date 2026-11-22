import { AUTHORIZATION_SOURCE_LABEL } from '@/features/people-record/authorization';
import { ROLE_LABEL } from '@/features/users/role';
import { formatDatePtBr } from '@/lib/format-date-ptbr';
import type { AuditCategory, AuditValue } from './schemas';

/** C11: rótulos da trilha em pt-BR. GC12: valor de enum nunca aparece cru. */

const EMPTY_VALUE = '—';
const APP_TIME_ZONE = 'America/Manaus';

const CATEGORY_LABEL: Record<AuditCategory, string> = {
  PERSON: 'Pessoa',
  ASSIGNMENT: 'Vínculo e setor',
  SCHEDULE: 'Escala',
  STRUCTURE: 'Estrutura',
  PERMISSIONS: 'Permissões',
};

const FIELD_LABEL: Record<string, string> = {
  name: 'Nome',
  registration: 'Matrícula',
  jobTitle: 'Função',
  phone: 'Telefone',
  email: 'E-mail',
  role: 'Papel',
  hasAccess: 'Acesso ao sistema',
  isActive: 'Situação',
  contactAuthorization: 'Autorização de contato',
  authorizationSource: 'Origem da autorização',
  authorizationNote: 'Detalhe da origem',
  authorizationDate: 'Data da autorização',
  sector: 'Setor',
  shift: 'Turno',
  level: 'Nível',
  manager: 'Gestor',
};

const ACTION_LABEL: Record<string, string> = {
  'user.invited': 'Usuário convidado',
  'user.person_created': 'Pessoa cadastrada',
  'user.profile_updated': 'Dados da pessoa alterados',
  'user.updated': 'Dados da pessoa alterados',
  'user.authorization_changed': 'Autorização de contato alterada',
  'user.role_changed': 'Papel alterado',
  'user.deactivated': 'Pessoa inativada',
  'user.reactivated': 'Pessoa reativada',
  'user.access_granted': 'Acesso ao sistema concedido',
  'user.deleted': 'Pessoa excluída',
  'user.password_reset': 'Senha redefinida',
  'sector.created': 'Setor criado',
  'sector.updated': 'Setor editado',
  'sector_people.person_moved': 'Pessoa movida de setor',
  'sector_people.person_removed': 'Pessoa tirada do setor',
  'sector_people.moved': 'Pessoas movidas de setor',
  'sector_people.removed': 'Pessoa tirada do setor',
  'sector_people.added': 'Pessoas adicionadas ao setor',
  'staff_schedule.put': 'Escala alterada',
  'staff_schedule.delete': 'Escala removida',
  'staff_schedule.exception_create': 'Exceção de escala criada',
  'staff_schedule.exception_delete': 'Exceção de escala removida',
  'shift.create': 'Turno criado',
  'shift.update': 'Turno editado',
  'shift.reorder': 'Turnos reordenados',
  'level.create': 'Nível criado',
  'level.update': 'Nível editado',
  'level.reorder': 'Níveis reordenados',
  'auth.login_success': 'Entrada no sistema',
  'auth.login_failed': 'Tentativa de entrada recusada',
  'auth.logout': 'Saída do sistema',
  'auth.refresh': 'Sessão renovada',
  'auth.password_changed': 'Senha alterada',
};

const AUTHORIZATION_STATUS_LABEL: Record<string, string> = {
  AUTORIZADO: 'Autorizado',
  NAO_AUTORIZADO: 'Sem autorização',
};

const AUTHORIZATION_SOURCE_VALUE_LABEL: Record<string, string> = {
  ...AUTHORIZATION_SOURCE_LABEL,
  CADASTRO_ANTERIOR: 'Cadastro anterior — origem não verificada',
};

/** Texto do mapa; chave fora dele (ou herdada do protótipo) devolve a própria chave. */
function lookup(map: Record<string, string>, key: string): string {
  return Object.hasOwn(map, key) ? map[key] : key;
}

export function categoryLabel(category: AuditCategory | null): string {
  return category === null ? 'Outros' : CATEGORY_LABEL[category];
}

export function fieldLabel(field: string): string {
  return lookup(FIELD_LABEL, field);
}

export function actionLabel(action: string): string {
  return lookup(ACTION_LABEL, action);
}

/** Data e hora (`dd/mm/aaaa hh:mm`) no fuso do app. */
export function formatAuditDateTime(iso: string): string {
  const parts = new Intl.DateTimeFormat('pt-BR', {
    timeZone: APP_TIME_ZONE,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(iso));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
  return `${part('day')}/${part('month')}/${part('year')} ${part('hour')}:${part('minute')}`;
}

const CIVIL_DATE = /^\d{4}-\d{2}-\d{2}$/;

const TEXT_FORMATTER: Record<string, (value: string) => string> = {
  role: (value) => lookup(ROLE_LABEL, value),
  contactAuthorization: (value) => lookup(AUTHORIZATION_STATUS_LABEL, value),
  authorizationSource: (value) => lookup(AUTHORIZATION_SOURCE_VALUE_LABEL, value),
  authorizationDate: (value) => (CIVIL_DATE.test(value) ? formatDatePtBr(value) : value),
};

function booleanLabel(field: string, value: boolean): string {
  if (field === 'isActive') return value ? 'Ativa' : 'Inativa';
  return value ? 'Sim' : 'Não';
}

/** Valor de um campo da trilha por extenso; telefone e e-mail já chegam mascarados da API. */
export function formatAuditValue(field: string, value: AuditValue): string {
  if (value === null || value === '') return EMPTY_VALUE;
  if (typeof value === 'object') return value.name;
  if (typeof value === 'boolean') return booleanLabel(field, value);
  if (typeof value === 'number') return String(value);
  return Object.hasOwn(TEXT_FORMATTER, field) ? TEXT_FORMATTER[field](value) : value;
}
