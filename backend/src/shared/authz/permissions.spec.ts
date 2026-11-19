import { describe, expect, it } from 'vitest';
import { DomainError } from '../errors/domain.error';
import {
  PERMISSION_DENIED_TEXT,
  PERMISSION_KEYS,
  defaultPermissionsFor,
  hasPermission,
  permissionDenied,
  resolvePermissions,
} from './permissions';
import { actorWith, permissionsWith } from './actor.test-fixtures';

describe('defaultPermissionsFor', () => {
  it('defaultPermissionsFor: ADMIN todas, VIEWER nenhuma, SUPERVISOR sem estrutura.manter, OPERATOR as 5 de B2', () => {
    expect(defaultPermissionsFor('ADMIN')).toEqual([...PERMISSION_KEYS]);
    expect(defaultPermissionsFor('VIEWER')).toEqual([]);
    expect(defaultPermissionsFor('SUPERVISOR')).toEqual(
      PERMISSION_KEYS.filter((key) => key !== 'estrutura.manter'),
    );
    expect(defaultPermissionsFor('OPERATOR')).toEqual([
      'pessoas.editar',
      'escala.alterar',
      'telefone.ver_completo',
      'equipe.enviar',
      'equipe.disparo_amplo',
    ]);
  });
});

describe('resolvePermissions', () => {
  it('resolvePermissions: linha vence o padrão; ausente cai no padrão; chave desconhecida ignorada; ADMIN e VIEWER ignoram linhas', () => {
    const supervisorRows = [
      { key: 'trilha.consultar', granted: false },
      { key: 'estrutura.manter', granted: true },
      { key: 'pessoas.exportar', granted: true },
    ];
    const allFalse = PERMISSION_KEYS.map((key) => ({ key, granted: false }));
    const allTrue = PERMISSION_KEYS.map((key) => ({ key, granted: true }));

    expect(resolvePermissions('SUPERVISOR', supervisorRows)).toEqual(
      PERMISSION_KEYS.filter((key) => key !== 'trilha.consultar'),
    );
    expect(resolvePermissions('OPERATOR', [])).toEqual(
      defaultPermissionsFor('OPERATOR'),
    );
    expect(resolvePermissions('ADMIN', allFalse)).toEqual([...PERMISSION_KEYS]);
    expect(resolvePermissions('VIEWER', allTrue)).toEqual([]);
  });
});

describe('hasPermission', () => {
  it('hasPermission: só vale para chave presente em permissions', () => {
    const holder = { permissions: permissionsWith('OPERATOR') };

    expect(hasPermission(holder, 'escala.alterar')).toBe(true);
    expect(hasPermission(holder, 'trilha.consultar')).toBe(false);
  });
});

describe('permissionDenied', () => {
  it('permissionDenied devolve 403 auth.permission_denied com title "Ação não permitida" e detail da chave', () => {
    const error = permissionDenied('equipe.disparo_amplo');

    expect(error).toBeInstanceOf(DomainError);
    expect(error).toMatchObject({
      code: 'auth.permission_denied',
      status: 403,
      message: 'Ação não permitida',
      detail:
        'Você não tem permissão para enviar a todos os setores de uma vez.',
    });
  });

  it('PERMISSION_DENIED_TEXT tem texto para cada uma das 8 chaves', () => {
    expect(Object.keys(PERMISSION_DENIED_TEXT).sort()).toEqual(
      [...PERMISSION_KEYS].sort(),
    );
    for (const key of PERMISSION_KEYS) {
      expect(PERMISSION_DENIED_TEXT[key]).toMatch(
        /^Você não tem permissão para .+\.$/,
      );
    }
  });
});

describe('fixture de ator', () => {
  it('permissionsWith: padrão do papel mais grant menos revoke, na ordem de PERMISSION_KEYS', () => {
    expect(
      permissionsWith('OPERATOR', {
        grant: ['trilha.consultar', 'estrutura.manter'],
        revoke: ['pessoas.editar'],
      }),
    ).toEqual([
      'escala.alterar',
      'estrutura.manter',
      'telefone.ver_completo',
      'equipe.enviar',
      'equipe.disparo_amplo',
      'trilha.consultar',
    ]);
    expect(permissionsWith('VIEWER')).toEqual([]);
  });

  it('actorWith: ator ativo com acesso, id padrão ou informado e permissões do papel', () => {
    const actor = actorWith('SUPERVISOR', { revoke: ['pessoas.inativar'] });

    expect(actor).toEqual({
      id: actor.id,
      role: 'SUPERVISOR',
      isActive: true,
      hasAccess: true,
      permissions: permissionsWith('SUPERVISOR', {
        revoke: ['pessoas.inativar'],
      }),
    });
    expect(actor.id).not.toBe('');
    expect(actorWith('ADMIN', { id: 'admin-7' }).id).toBe('admin-7');
  });
});
