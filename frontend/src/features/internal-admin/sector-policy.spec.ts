import { describe, expect, it } from 'vitest';
import { canSetSectorManagerUi } from './sector-policy';

describe('canSetSectorManagerUi', () => {
  it('só ADMIN escolhe o gestor do setor', () => {
    expect(canSetSectorManagerUi('ADMIN')).toBe(true);
    expect(canSetSectorManagerUi('SUPERVISOR')).toBe(false);
    expect(canSetSectorManagerUi('OPERATOR')).toBe(false);
    expect(canSetSectorManagerUi('VIEWER')).toBe(false);
    expect(canSetSectorManagerUi(undefined)).toBe(false);
  });
});
