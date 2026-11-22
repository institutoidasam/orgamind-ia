import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HTTPError } from 'ky';
import type { ComponentType } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ dispatch: vi.fn() }));

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (opts: Record<string, unknown>) => ({ ...opts, useParams: () => ({ dispatchId: 'd1' }) }),
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => <a href={to}>{children}</a>,
}));
vi.mock('@/features/team-whatsapp/api', () => ({ useTeamDispatch: (id: string) => mocks.dispatch(id) }));
vi.mock('@/features/team-whatsapp/components/dispatch-result', () => ({
  DispatchResult: ({ dispatch }: { dispatch: { id: string } }) => <h1>Resultado do envio {dispatch.id}</h1>,
}));

import { Route } from './$dispatchId';

const route = Route as unknown as { component: ComponentType };

function httpError(status: number, code?: string) {
  const body = code ? JSON.stringify({ code }) : '{}';
  return new HTTPError(new Response(body, { status }), new Request('https://x'), {} as never);
}

beforeEach(() => vi.clearAllMocks());

describe('/whatsapp-equipe/$dispatchId', () => {
  it('pede o envio do parâmetro da rota e mostra o resultado', () => {
    mocks.dispatch.mockReturnValue({ data: { id: 'd1' }, isLoading: false, isError: false });
    render(<route.component />);
    expect(mocks.dispatch).toHaveBeenCalledWith('d1');
    expect(screen.getByRole('heading', { name: 'Resultado do envio d1' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Voltar' })).toHaveAttribute('href', '/whatsapp-equipe');
  });

  it('404 dispatch_not_found mostra Envio não encontrado., sem Tentar novamente', async () => {
    mocks.dispatch.mockReturnValue({
      data: undefined, isLoading: false, isError: true, error: httpError(404, 'team_whatsapp.dispatch_not_found'),
    });
    render(<route.component />);
    expect(await screen.findByText('Envio não encontrado.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Tentar novamente' })).not.toBeInTheDocument();
  });

  it('outro erro mostra o QueryErrorFallback, que consulta de novo', async () => {
    const refetch = vi.fn();
    mocks.dispatch.mockReturnValue({ data: undefined, isLoading: false, isError: true, error: httpError(500), refetch });
    render(<route.component />);
    await userEvent.click(await screen.findByRole('button', { name: 'Tentar novamente' }));
    expect(refetch).toHaveBeenCalled();
    expect(screen.queryByText('Envio não encontrado.')).not.toBeInTheDocument();
  });

  it('mostra o esqueleto enquanto carrega', () => {
    mocks.dispatch.mockReturnValue({ data: undefined, isLoading: true, isError: false });
    const { container } = render(<route.component />);
    expect(container.querySelector('[data-slot="skeleton"], .animate-pulse')).not.toBeNull();
  });
});
