import { describe, expect, it } from 'vitest';
import { canChangePersonStatusUi, canQueryAuditTrailUi, canViewPersonHistoryUi } from './ui-policy';

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
