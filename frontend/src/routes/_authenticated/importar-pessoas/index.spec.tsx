import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentType } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  user: { role: 'ADMIN' } as { role: string; permissions?: string[] } | null,
  search: {} as { lote?: string },
  redirect: vi.fn((opts: Record<string, unknown>) => ({ __redirect: opts })),
  navigate: vi.fn(),
}));

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (opts: Record<string, unknown>) => ({ ...opts, useSearch: () => mocks.search }),
  redirect: mocks.redirect,
  useNavigate: () => mocks.navigate,
}));
vi.mock('@/stores/auth.store', () => ({
  useAuthStore: { getState: () => ({ user: mocks.user }) },
}));
vi.mock('@/features/people-import/components/import-page', () => ({
  ImportPage: ({
    batchId,
    onBatchChange,
  }: {
    batchId?: string;
    onBatchChange: (id?: string, options?: { replace?: boolean }) => void;
  }) => (
    <div>
      lote:{batchId ?? 'nenhum'}
      <button onClick={() => onBatchChange('b2')}>abrir</button>
      <button onClick={() => onBatchChange(undefined, { replace: true })}>limpar</button>
    </div>
  ),
}));

import { Route } from './index';

const route = Route as unknown as {
  component: ComponentType;
  beforeLoad: () => void;
  validateSearch: (search: Record<string, unknown>) => { lote?: string };
};

beforeEach(() => {
  mocks.redirect.mockClear();
  mocks.navigate.mockClear();
  mocks.search = {};
});

describe('/importar-pessoas: acesso por permissão', () => {
  it('rota só para quem tem pessoas.importar', () => {
    mocks.user = { role: 'OPERATOR', permissions: ['pessoas.importar'] };
    expect(() => route.beforeLoad()).not.toThrow();
    mocks.user = { role: 'ADMIN' };
    expect(() => route.beforeLoad()).not.toThrow();
    mocks.user = { role: 'SUPERVISOR', permissions: ['pessoas.editar'] };
    expect(() => route.beforeLoad()).toThrow();
    expect(mocks.redirect).toHaveBeenCalledWith({ to: '/dashboard' });
  });
});

describe('/importar-pessoas: lote na URL', () => {
  it('o lote vem de ?lote e a troca de lote vai para a URL (limpar substitui a entrada)', async () => {
    mocks.search = { lote: 'b1' };
    render(<route.component />);
    expect(screen.getByText(/lote:b1/)).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'abrir' }));
    expect(mocks.navigate).toHaveBeenLastCalledWith({
      to: '/importar-pessoas',
      search: { lote: 'b2' },
      replace: false,
    });
    await user.click(screen.getByRole('button', { name: 'limpar' }));
    expect(mocks.navigate).toHaveBeenLastCalledWith({ to: '/importar-pessoas', search: {}, replace: true });
  });

  it('só um ?lote de texto não vazio é aceito', () => {
    expect(route.validateSearch({ lote: 'b1' })).toEqual({ lote: 'b1' });
    expect(route.validateSearch({ lote: '' })).toEqual({});
    expect(route.validateSearch({ lote: 7 })).toEqual({});
    expect(route.validateSearch({})).toEqual({});
  });
});
