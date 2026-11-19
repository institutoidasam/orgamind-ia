import { describe, expect, it } from 'vitest';
import { DEFAULT_PERMISSIONS } from '@/features/permissions/keys';
import { canChangePersonStatusUi, canQueryAuditTrailUi, canViewPersonHistoryUi } from './ui-policy';

describe('ui-policy: sem o argumento permissions vale o padrão do papel', () => {
  it.each(['ADMIN', 'SUPERVISOR', 'OPERATOR', 'VIEWER'] as const)(
    '%s: a lista padrão e a ausência dela dão a mesma resposta',
    (role) => {
      const defaults = DEFAULT_PERMISSIONS[role];
      for (const hasAccess of [true, false]) {
        expect(canChangePersonStatusUi(role, { hasAccess }, defaults)).toBe(canChangePersonStatusUi(role, { hasAccess }));
      }
      expect(canViewPersonHistoryUi(role, defaults)).toBe(canViewPersonHistoryUi(role));
    },
  );
});

describe('canChangePersonStatusUi: por permissão', () => {
  it('OPERATOR com pessoas.inativar muda quem não tem login, não quem tem', () => {
    expect(canChangePersonStatusUi('OPERATOR', { hasAccess: false }, ['pessoas.inativar'])).toBe(true);
    expect(canChangePersonStatusUi('OPERATOR', { hasAccess: true }, ['pessoas.inativar'])).toBe(false);
  });

  it('SUPERVISOR sem pessoas.inativar não muda ninguém', () => {
    expect(canChangePersonStatusUi('SUPERVISOR', { hasAccess: false }, [])).toBe(false);
  });
});

describe('canViewPersonHistoryUi: por permissão', () => {
  it('SUPERVISOR sem trilha.consultar não vê; OPERATOR com a chave vê; ADMIN vê sempre', () => {
    expect(canViewPersonHistoryUi('SUPERVISOR', ['pessoas.editar'])).toBe(false);
    expect(canViewPersonHistoryUi('OPERATOR', ['trilha.consultar'])).toBe(true);
    expect(canViewPersonHistoryUi('ADMIN', [])).toBe(true);
  });
});

describe('canChangePersonStatusUi', () => {
  it('ADMIN muda qualquer pessoa; SUPERVISOR só quem não tem login; OPERATOR e VIEWER nunca', () => {
    expect(canChangePersonStatusUi('ADMIN', { hasAccess: true })).toBe(true);
    expect(canChangePersonStatusUi('SUPERVISOR', { hasAccess: false })).toBe(true);
    expect(canChangePersonStatusUi('SUPERVISOR', { hasAccess: true })).toBe(false);
    expect(canChangePersonStatusUi('OPERATOR', { hasAccess: false })).toBe(false);
    expect(canChangePersonStatusUi('VIEWER', { hasAccess: false })).toBe(false);
  });
});

describe('canViewPersonHistoryUi e canQueryAuditTrailUi', () => {
  it('histórico da pessoa: ADMIN e SUPERVISOR; consulta geral: só ADMIN', () => {
    expect(canViewPersonHistoryUi('ADMIN')).toBe(true);
    expect(canViewPersonHistoryUi('SUPERVISOR')).toBe(true);
    expect(canViewPersonHistoryUi('OPERATOR')).toBe(false);
    expect(canQueryAuditTrailUi('ADMIN')).toBe(true);
    expect(canQueryAuditTrailUi('SUPERVISOR')).toBe(false);
  });
});
