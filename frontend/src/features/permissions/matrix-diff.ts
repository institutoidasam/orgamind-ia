import { PERMISSION_KEYS, toPermissionKeys, type PermissionKey } from './keys';
import type { PermissionMatrix } from './schemas';

export type EditableRole = 'SUPERVISOR' | 'OPERATOR';
export type MatrixDraft = Record<EditableRole, PermissionKey[]>;
export type MatrixChange = { role: EditableRole; key: PermissionKey; granted: boolean };

const EDITABLE_ROLES: readonly EditableRole[] = ['SUPERVISOR', 'OPERATOR'];

/** Rascunho editável a partir da matriz do servidor: só os dois papéis que a tela muda. */
export function toDraft(roles: Pick<PermissionMatrix['roles'], EditableRole>): MatrixDraft {
  return { SUPERVISOR: [...roles.SUPERVISOR], OPERATOR: [...roles.OPERATOR] };
}

/** Marca ou desmarca uma permissão de um papel, sem mexer no outro e na ordem de PERMISSION_KEYS. */
export function setGranted(draft: MatrixDraft, role: EditableRole, key: PermissionKey, granted: boolean): MatrixDraft {
  const list = granted ? toPermissionKeys([...draft[role], key]) : draft[role].filter((item) => item !== key);
  return { ...draft, [role]: list };
}

/**
 * O que muda entre a matriz do servidor e o rascunho: um item por célula
 * diferente, por papel e na ordem de PERMISSION_KEYS. Sem diferença, lista vazia.
 */
export function matrixChanges(current: PermissionMatrix['roles'], draft: MatrixDraft): MatrixChange[] {
  return EDITABLE_ROLES.flatMap((role) =>
    PERMISSION_KEYS.flatMap((key) => {
      const granted = draft[role].includes(key);
      return current[role].includes(key) === granted ? [] : [{ role, key, granted }];
    }),
  );
}
