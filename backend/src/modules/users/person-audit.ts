import type { Prisma } from '@prisma/client';
import {
  diffFields,
  maskEmail,
  maskPhone,
  type AuditValue,
  type FieldChange,
} from '../../shared/audit/audit-change';
import { fromDbDate } from '../staff-schedule/civil-date';

/**
 * Retrato da pessoa que a trilha compara (C5, GC2). Sem `password`; setor,
 * turno e nível vêm só como `{ id, name }`. `authorizationRecordedAt/ById` ficam
 * de fora de propósito (D17): não são campos da ficha.
 */
export const personAuditSelect = {
  name: true,
  registration: true,
  jobTitle: true,
  phoneE164: true,
  email: true,
  role: true,
  hasAccess: true,
  isActive: true,
  contactAuthorization: true,
  authorizationSource: true,
  authorizationNote: true,
  authorizationDate: true,
  sector: { select: { id: true, name: true } },
  workShift: { select: { id: true, name: true } },
  level: { select: { id: true, name: true } },
} satisfies Prisma.UserSelect;

export type PersonAuditRow = Prisma.UserGetPayload<{
  select: typeof personAuditSelect;
}>;

function personFields(row: PersonAuditRow): Record<string, AuditValue> {
  return {
    name: row.name,
    registration: row.registration,
    jobTitle: row.jobTitle,
    phone: row.phoneE164,
    email: row.email,
    role: row.role,
    hasAccess: row.hasAccess,
    isActive: row.isActive,
    contactAuthorization: row.contactAuthorization,
    authorizationSource: row.authorizationSource,
    authorizationNote: row.authorizationNote,
    authorizationDate: row.authorizationDate
      ? fromDbDate(row.authorizationDate)
      : null,
    sector: row.sector,
    shift: row.workShift,
    level: row.level,
  };
}

/** Telefone e e-mail saem mascarados; o resto vai por extenso. */
function presentPersonField(field: string, value: AuditValue): AuditValue {
  const text = typeof value === 'string' ? value : null;
  if (field === 'phone') return maskPhone(text);
  if (field === 'email') return maskEmail(text);
  return value;
}

/**
 * Campos da pessoa que mudaram (`null` = lado inexistente). Compara o valor
 * cru e só então mascara: dois telefones de mesmo final continuam sendo uma
 * alteração, com os dois lados iguais na saída.
 */
export function personAuditChanges(
  before: PersonAuditRow | null,
  after: PersonAuditRow | null,
): FieldChange[] {
  return diffFields(
    before && personFields(before),
    after && personFields(after),
    presentPersonField,
  );
}

const AUTHORIZATION_FIELDS: ReadonlySet<string> = new Set([
  'contactAuthorization',
  'authorizationSource',
  'authorizationNote',
  'authorizationDate',
]);

/**
 * Ação da trilha de uma edição (C5): situação (`isActive`) primeiro, depois
 * troca de papel, depois só autorização; o resto é edição da ficha.
 */
export function personChangeAction(changes: readonly FieldChange[]): string {
  const status = changes.find((change) => change.field === 'isActive');
  if (status)
    return status.after === true ? 'user.reactivated' : 'user.deactivated';
  if (changes.some((change) => change.field === 'role'))
    return 'user.role_changed';
  if (
    changes.length > 0 &&
    changes.every((change) => AUTHORIZATION_FIELDS.has(change.field))
  )
    return 'user.authorization_changed';
  return 'user.profile_updated';
}
