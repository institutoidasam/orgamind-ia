import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ role: 'SUPERVISOR', permissions: undefined as string[] | undefined }));

vi.mock('@/stores/auth.store', () => ({
  useAuthStore: (select: (s: { user: { role: string; permissions?: string[] } }) => unknown) =>
    select({ user: { role: mocks.role, permissions: mocks.permissions } }),
}));
vi.mock('../api', () => ({
  useRemoveSectorPerson: () => ({ mutateAsync: vi.fn() }),
  useSetSectorPersonStatus: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock('./audit-trail-refresh', () => ({ useRefreshAuditTrail: () => vi.fn() }));
vi.mock('@/features/audit-trail/components/person-history-dialog', () => ({ PersonHistoryDialog: () => null }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { PeopleTable } from './people-table';
import type { SectorPerson } from '../schemas';

const authorization = { status: 'NAO_AUTORIZADO', source: null, note: null, date: null, recordedAt: null } as const;
const free: SectorPerson = {
  id: 'u2', name: 'Bia', phoneE164: null, hasPhone: true, phoneMasked: '•••• 7777', hasAccess: false, role: null, level: null,
  jobTitle: null, shift: null, editable: 'full', registration: null, isActive: true, contactAuthorization: authorization,
};
const withAccess: SectorPerson = { ...free, id: 'u1', name: 'Ana', hasAccess: true, role: 'OPERATOR', editable: 'limited' };

const renderTable = () => render(<PeopleTable sectorId="s1" people={[withAccess, free]} onEdit={vi.fn()} />);
const buttons = (name: string) => screen.queryAllByRole('button', { name });

beforeEach(() => {
  mocks.role = 'SUPERVISOR';
  mocks.permissions = undefined;
});

describe('PeopleTable: ações por permissão', () => {
  it('sem pessoas.editar some Editar/Mover/Tirar; Inativar e Histórico seguem as suas chaves', () => {
    mocks.permissions = ['pessoas.inativar', 'trilha.consultar'];
    renderTable();
    expect(buttons('Editar')).toHaveLength(0);
    expect(buttons('Tirar do setor')).toHaveLength(0);
    expect(buttons('Inativar')).toHaveLength(1); // quem tem acesso só o ADMIN inativa
    expect(buttons('Histórico')).toHaveLength(2);
  });

  it('só com pessoas.editar mostra Editar e Tirar do setor (só de quem não tem acesso), sem Inativar nem Histórico', () => {
    mocks.permissions = ['pessoas.editar'];
    renderTable();
    expect(buttons('Editar')).toHaveLength(2);
    expect(buttons('Tirar do setor')).toHaveLength(1);
    expect(buttons('Inativar')).toHaveLength(0);
    expect(buttons('Histórico')).toHaveLength(0);
  });

  it('com a matriz inicial a tabela fica como hoje (GB1)', () => {
    renderTable();
    expect(buttons('Editar')).toHaveLength(2);
    expect(buttons('Tirar do setor')).toHaveLength(1);
    expect(buttons('Inativar')).toHaveLength(1);
    expect(buttons('Histórico')).toHaveLength(2);
  });
});
