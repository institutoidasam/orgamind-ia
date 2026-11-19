import { describe, expect, it } from 'vitest';
import { effectivePermissions, hasPermission } from './access';
import { DEFAULT_PERMISSIONS, PERMISSION_KEYS, toPermissionKeys } from './keys';

describe('matriz padrão: exportar pessoas e escala', () => {
  it('SUPERVISOR e OPERATOR não têm pessoas.exportar por padrão; ADMIN tem', () => {
    const supervisor = { role: 'SUPERVISOR' as const };
    const operator = { role: 'OPERATOR' as const };

    expect(hasPermission(supervisor, 'pessoas.exportar')).toBe(false);
    expect(hasPermission(operator, 'pessoas.exportar')).toBe(false);
    expect(hasPermission({ role: 'ADMIN' as const }, 'pessoas.exportar')).toBe(true);
    expect(DEFAULT_PERMISSIONS.SUPERVISOR).toEqual([
      'pessoas.editar',
      'pessoas.inativar',
      'escala.alterar',
      'telefone.ver_completo',
      'equipe.enviar',
      'equipe.disparo_amplo',
      'trilha.consultar',
    ]);
    expect(PERMISSION_KEYS[PERMISSION_KEYS.length - 1]).toBe('pessoas.exportar');
  });
});

describe('effectivePermissions', () => {
  it('sessão sem permissions usa o padrão do papel', () => {
    const operator = { role: 'OPERATOR' as const };

    expect(hasPermission(operator, 'escala.alterar')).toBe(true);
    expect(hasPermission(operator, 'trilha.consultar')).toBe(false);
    expect(effectivePermissions({ role: 'ADMIN' })).toEqual(PERMISSION_KEYS);
    expect(effectivePermissions({ role: 'VIEWER' })).toEqual([]);
    expect(DEFAULT_PERMISSIONS.SUPERVISOR).not.toContain('estrutura.manter');
    expect(DEFAULT_PERMISSIONS.SUPERVISOR).toHaveLength(PERMISSION_KEYS.length - 2);
  });

  it('com permissions vale só a lista da API, não o padrão do papel', () => {
    const operator = { role: 'OPERATOR' as const, permissions: ['trilha.consultar' as const] };

    expect(effectivePermissions(operator)).toEqual(['trilha.consultar']);
    expect(hasPermission(operator, 'escala.alterar')).toBe(false);
  });

  it('sem sessão não há permissão nenhuma', () => {
    expect(effectivePermissions(null)).toEqual([]);
    expect(hasPermission(null, 'pessoas.editar')).toBe(false);
  });
});

describe('toPermissionKeys', () => {
  it('descarta chave desconhecida e mantém a ordem de PERMISSION_KEYS', () => {
    const raw = ['trilha.consultar', 'futuro.nova_chave', 'pessoas.editar'];

    expect(toPermissionKeys(raw)).toEqual(['pessoas.editar', 'trilha.consultar']);
  });
});
