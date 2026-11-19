import { describe, expect, it } from 'vitest';
import { sectorAuditChanges, type SectorAuditRow } from './sector-audit';

const ANA = { id: 'u-ana', name: 'Ana Souza' };
const BRUNO = { id: 'u-bruno', name: 'Bruno Lima' };

function row(overrides: Partial<SectorAuditRow> = {}): SectorAuditRow {
  return {
    id: 's1',
    name: 'Compras',
    isActive: true,
    manager: null,
    ...overrides,
  };
}

describe('sectorAuditChanges (A5)', () => {
  it('criação lista nome, gestor { id, name } e ativo', () => {
    const created = row({ manager: ANA });

    expect(sectorAuditChanges(null, created)).toEqual([
      { field: 'name', before: null, after: 'Compras' },
      { field: 'manager', before: null, after: ANA },
      { field: 'isActive', before: null, after: true },
    ]);
  });

  it('edição só com o gestor trocado gera uma única alteração', () => {
    const changes = sectorAuditChanges(
      row({ manager: ANA }),
      row({ manager: BRUNO }),
    );

    expect(changes).toEqual([{ field: 'manager', before: ANA, after: BRUNO }]);
  });

  it('gestor entra só com id e nome, sem e-mail nem telefone', () => {
    const withContact = {
      ...ANA,
      email: 'ana@gbr.com.br',
      phone: '+5592988887777',
    };

    const changes = sectorAuditChanges(row(), row({ manager: withContact }));

    expect(JSON.stringify(changes)).not.toMatch(/ana@|5592988887777|email/);
    expect(changes).toEqual([{ field: 'manager', before: null, after: ANA }]);
  });

  it('gestor sem nome cadastrado entra com nome vazio e o id', () => {
    const nameless = { id: 'u-sem-nome', name: null };

    expect(sectorAuditChanges(row(), row({ manager: nameless }))).toEqual([
      { field: 'manager', before: null, after: { id: 'u-sem-nome', name: '' } },
    ]);
  });

  it('renomear o gestor não é trocar de gestor', () => {
    const renamed = { id: ANA.id, name: 'Ana S. Souza' };

    expect(
      sectorAuditChanges(row({ manager: ANA }), row({ manager: renamed })),
    ).toEqual([]);
  });
});
