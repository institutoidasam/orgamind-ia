import { describe, expect, it } from 'vitest';
import { DEFAULT_PERMISSIONS, type PermissionKey } from './keys';
import { matrixChanges, setGranted, toDraft } from './matrix-diff';
import type { PermissionMatrix } from './schemas';

const CURRENT: PermissionMatrix['roles'] = {
  ADMIN: [...DEFAULT_PERMISSIONS.ADMIN],
  SUPERVISOR: [...DEFAULT_PERMISSIONS.SUPERVISOR],
  OPERATOR: ['pessoas.editar', 'escala.alterar'],
  VIEWER: [],
};

function draftWith(operator: PermissionKey[]) {
  return { SUPERVISOR: [...CURRENT.SUPERVISOR], OPERATOR: operator };
}

describe('matrixChanges', () => {
  it('permissão marcada que não estava vira ganho do papel', () => {
    const draft = draftWith(['pessoas.editar', 'escala.alterar', 'equipe.enviar']);

    expect(matrixChanges(CURRENT, draft)).toEqual([
      { role: 'OPERATOR', key: 'equipe.enviar', granted: true },
    ]);
  });

  it('permissão desmarcada que estava vira perda do papel', () => {
    expect(matrixChanges(CURRENT, draftWith(['pessoas.editar']))).toEqual([
      { role: 'OPERATOR', key: 'escala.alterar', granted: false },
    ]);
  });

  it('sem diferença não há mudança; ganhos e perdas saem por papel e na ordem das chaves', () => {
    expect(matrixChanges(CURRENT, toDraft(CURRENT))).toEqual([]);

    const draft = {
      SUPERVISOR: CURRENT.SUPERVISOR.filter((key) => key !== 'pessoas.editar'),
      OPERATOR: ['trilha.consultar', 'escala.alterar'] as PermissionKey[],
    };
    expect(matrixChanges(CURRENT, draft)).toEqual([
      { role: 'SUPERVISOR', key: 'pessoas.editar', granted: false },
      { role: 'OPERATOR', key: 'pessoas.editar', granted: false },
      { role: 'OPERATOR', key: 'trilha.consultar', granted: true },
    ]);
  });
});

describe('setGranted', () => {
  it('marca e desmarca só o papel indicado, mantendo a ordem das chaves', () => {
    const draft = draftWith(['escala.alterar']);

    const marked = setGranted(draft, 'OPERATOR', 'pessoas.editar', true);
    expect(marked.OPERATOR).toEqual(['pessoas.editar', 'escala.alterar']);
    expect(marked.SUPERVISOR).toBe(draft.SUPERVISOR);
    expect(setGranted(marked, 'OPERATOR', 'escala.alterar', false).OPERATOR).toEqual(['pessoas.editar']);
  });
});
