import { describe, expect, it } from 'vitest';
import {
  levelAuditChanges,
  levelEvent,
  type LevelAuditRow,
} from './level-audit';

const LEADER: LevelAuditRow = {
  id: 'level_leader',
  name: 'Líder',
  isActive: true,
};

describe('levelAuditChanges', () => {
  it('criação lista nome e ativo', () => {
    expect(levelAuditChanges(null, LEADER)).toEqual([
      { field: 'name', before: null, after: 'Líder' },
      { field: 'isActive', before: null, after: true },
    ]);
  });

  it('alteração só dos campos que mudaram', () => {
    const after = { ...LEADER, name: 'Líder sênior', isActive: false };
    expect(levelAuditChanges(LEADER, after)).toEqual([
      { field: 'name', before: 'Líder', after: 'Líder sênior' },
      { field: 'isActive', before: true, after: false },
    ]);
  });

  it('nada mudou — vazio', () => {
    expect(levelAuditChanges(LEADER, { ...LEADER })).toEqual([]);
  });
});

describe('levelEvent', () => {
  it('com campo alterado — evento STRUCTURE da entidade StaffLevel; sem campo — null', () => {
    const changes = levelAuditChanges(null, LEADER);

    expect(levelEvent('level.create', 'admin-1', LEADER.id, changes)).toEqual({
      action: 'level.create',
      actorId: 'admin-1',
      entity: 'StaffLevel',
      entityId: LEADER.id,
      category: 'STRUCTURE',
      changes,
    });
    expect(levelEvent('level.update', 'admin-1', LEADER.id, [])).toBeNull();
  });
});
