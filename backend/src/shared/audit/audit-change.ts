import type { AuditCategory } from '@prisma/client';

/** Pessoa, setor, turno ou nível citado numa alteração: id estável e nome legível. */
export type AuditRef = { id: string; name: string };
export type AuditValue = string | number | boolean | null | AuditRef;
export type FieldChange = {
  field: string;
  before: AuditValue;
  after: AuditValue;
};

export type AuditChange = {
  action: string;
  entity: string;
  entityId: string | null;
  category: AuditCategory;
  subjectUserId?: string | null;
  reason?: string | null;
  changes: FieldChange[];
  metadata?: Record<string, unknown>;
  /** Obrigatório e explícito: o CLS só fornece ip e user-agent. */
  actorId: string;
};

export type FieldPresenter = (field: string, value: AuditValue) => AuditValue;

/** Campos de credencial: nunca entram na trilha, nem crus nem mascarados. */
const NEVER_AUDITED_FIELD = /password|senha/i;

const MASK = '•••';

function isRef(value: AuditValue): value is AuditRef {
  return typeof value === 'object' && value !== null;
}

/** Compara o valor cru; `AuditRef` por `id` (renomear o setor não é alterar a pessoa). */
function sameValue(a: AuditValue, b: AuditValue): boolean {
  if (isRef(a) && isRef(b)) return a.id === b.id;
  return a === b;
}

function fieldNames(
  before: Readonly<Record<string, AuditValue>> | null,
  after: Readonly<Record<string, AuditValue>> | null,
): string[] {
  return [
    ...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]),
  ].filter((field) => !NEVER_AUDITED_FIELD.test(field));
}

/**
 * Campos que mudaram entre `before` e `after` (`null` = lado inexistente: na
 * criação lista só os não nulos). A comparação usa os valores crus; `present`
 * (máscara, rótulo) só é aplicado aos dois lados da saída.
 */
export function diffFields(
  before: Readonly<Record<string, AuditValue>> | null,
  after: Readonly<Record<string, AuditValue>> | null,
  present: FieldPresenter = (_field, value) => value,
): FieldChange[] {
  const changes: FieldChange[] = [];
  for (const field of fieldNames(before, after)) {
    const from = before?.[field] ?? null;
    const to = after?.[field] ?? null;
    if (sameValue(from, to)) continue;
    changes.push({
      field,
      before: present(field, from),
      after: present(field, to),
    });
  }
  return changes;
}

/** '+5592988887777' → '•••• 7777'; menos de 4 dígitos → '••••'; vazio → null. */
export function maskPhone(e164: string | null | undefined): string | null {
  if (!e164) return null;
  const digits = e164.replace(/\D/g, '');
  return digits.length < 4 ? '••••' : `•••• ${digits.slice(-4)}`;
}

/** 'ana@gbr.com.br' → 'a•••@gbr.com.br'; sem '@' → '•••'; vazio → null. */
export function maskEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.lastIndexOf('@');
  if (at < 0) return MASK;
  return `${email.slice(0, Math.min(1, at))}${MASK}${email.slice(at)}`;
}

const CATEGORY_BY_PREFIX: ReadonlyArray<readonly [string, AuditCategory]> = [
  ['user.', 'PERSON'],
  ['sector_people.', 'ASSIGNMENT'],
  ['assignment.', 'ASSIGNMENT'],
  ['staff_schedule.', 'SCHEDULE'],
  ['sector.', 'STRUCTURE'],
  ['shift.', 'STRUCTURE'],
  ['level.', 'STRUCTURE'],
  ['permission.', 'PERMISSIONS'],
];

/** Categoria derivada do prefixo da ação (D4); sem prefixo conhecido, `null`. */
export function categoryOfAction(action: string): AuditCategory | null {
  const hit = CATEGORY_BY_PREFIX.find(([prefix]) => action.startsWith(prefix));
  return hit ? hit[1] : null;
}
