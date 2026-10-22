import type { ComponentType } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  user: { role: 'ADMIN' } as { role: string } | null,
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
