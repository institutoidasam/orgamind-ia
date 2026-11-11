import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SectorsWithoutNumberNotice } from './sectors-without-number-notice';

const state = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock('@/features/internal-admin/api', () => ({ useSectors: () => state.current }));
vi.mock('@/components/query-error-fallback', () => ({
  QueryErrorFallback: () => <p>Falha ao carregar (fallback)</p>,
}));

const channel = { id: 'c1', name: 'Loja 1', phoneE164: null };

beforeEach(() => {
  state.current = { isError: false, refetch: vi.fn(), data: { items: [] } };
});

describe('SectorsWithoutNumberNotice', () => {
  it('lista as áreas sem número', () => {
    state.current = {
      isError: false,
      data: { items: [{ id: 'rh', name: 'RH', channel: null }, { id: 'log', name: 'Logística', channel }, { id: 'man', name: 'Manutenção', channel: null }] },
    };
    render(<SectorsWithoutNumberNotice />);
    expect(screen.getByText('Áreas sem número: RH, Manutenção')).toBeInTheDocument();
  });

  it('sem nenhuma área sem número, não mostra nada', () => {
    state.current = { isError: false, data: { items: [{ id: 'log', name: 'Logística', channel }] } };
    const { container } = render(<SectorsWithoutNumberNotice />);
    expect(container).toBeEmptyDOMElement();
  });

  it('erro ao carregar os setores mostra o QueryErrorFallback', () => {
    state.current = { isError: true, error: new Error('x'), refetch: vi.fn() };
    render(<SectorsWithoutNumberNotice />);
    expect(screen.getByText('Falha ao carregar (fallback)')).toBeInTheDocument();
  });
});
