import type { ComponentType } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  user: { role: 'ADMIN' } as { role: string; permissions?: string[] } | null,
  redirect: vi.fn((opts: Record<string, unknown>) => ({ __redirect: opts })),
}));

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (opts: Record<string, unknown>) => ({ ...opts }),
  redirect: mocks.redirect,
  useNavigate: () => vi.fn(),
}));
vi.mock('@/stores/auth.store', () => ({ useAuthStore: { getState: () => ({ user: mocks.user }) } }));
vi.mock('@/features/internal-admin/api', () => ({ useCreateSector: () => ({ isPending: false, mutateAsync: vi.fn() }) }));
vi.mock('@/features/internal-admin/components/sector-form', () => ({ SectorForm: () => null }));

import { Route } from './new';

const route = Route as unknown as { component: ComponentType; beforeLoad: () => void };

describe('/setores/new: estrutura.manter', () => {
  it('SUPERVISOR com a chave entra; sem a chave (ou sem sessão) vai para o dashboard', () => {
    mocks.user = { role: 'SUPERVISOR', permissions: ['estrutura.manter'] };
    expect(() => route.beforeLoad()).not.toThrow();
    mocks.user = { role: 'OPERATOR', permissions: ['pessoas.editar'] };
    expect(() => route.beforeLoad()).toThrow();
    mocks.user = null;
    expect(() => route.beforeLoad()).toThrow();
    expect(mocks.redirect).toHaveBeenCalledTimes(2);
  });
});

describe('/setores/new', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.user = { role: 'ADMIN' };
  });

  it('segue só para ADMIN', () => {
    expect(() => route.beforeLoad()).not.toThrow();
  });

  it('gestor (não ADMIN) é redirecionado para o dashboard', () => {
    mocks.user = { role: 'SUPERVISOR' };
    expect(() => route.beforeLoad()).toThrow();
    expect(mocks.redirect).toHaveBeenCalledWith({ to: '/dashboard' });
  });
});
