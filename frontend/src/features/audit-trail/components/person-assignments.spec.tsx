import { render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HTTPError } from 'ky';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock('@/lib/api-client', () => ({ api: { get: mocks.get } }));

import { PersonAssignments } from './person-assignments';

const ref = (id: string, name: string) => ({ id, name });

const closed = {
  id: 'v2',
  sector: ref('s1', 'Triagem'),
  shift: ref('t1', 'Manhã'),
  level: ref('n1', 'Auxiliar'),
  from: '2026-03-02',
  to: '2026-08-31',
};

const open = {
  id: 'v1',
  sector: ref('s2', 'Enfermaria'),
  shift: ref('t2', 'Noite'),
  level: ref('n2', 'Técnico'),
  from: '2026-09-01',
  to: null,
};

function respondWith(items: unknown[]) {
  mocks.get.mockReturnValue({ json: () => Promise.resolve({ items }) });
}

function renderSection() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><PersonAssignments userId="u2" /></QueryClientProvider>);
}

beforeEach(() => {
  vi.clearAllMocks();
  respondWith([open, closed]);
});

describe('Vínculos da pessoa: lista', () => {
  it('mostra setor, turno, nível, de e até na ordem da API', async () => {
    renderSection();
    expect(screen.getByText('Carregando vínculos…')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Vínculos' })).toBeInTheDocument();
    const rows = await screen.findAllByRole('row');
    const headers = within(rows[0]).getAllByRole('columnheader').map((cell) => cell.textContent);
    expect(headers).toEqual(['Setor', 'Turno', 'Nível', 'De', 'Até']);
    const cells = rows.slice(1).map((row) => within(row).getAllByRole('cell').map((cell) => cell.textContent));
    expect(cells).toEqual([
      ['Enfermaria', 'Noite', 'Técnico', '01/09/2026', 'Atual'],
      ['Triagem', 'Manhã', 'Auxiliar', '02/03/2026', '31/08/2026'],
    ]);
    expect(mocks.get).toHaveBeenCalledWith('audit-trail/people/u2/assignments');
  });

  it('início em branco mostra "Anterior ao histórico" e fim em branco "Atual"', async () => {
    respondWith([{ ...open, from: null, to: null }]);
    renderSection();
    expect(await screen.findByText('Anterior ao histórico')).toBeInTheDocument();
    expect(screen.getByText('Atual')).toBeInTheDocument();
  });

  it('vazio mostra Sem setor, Sem turno e Sem nível', async () => {
    respondWith([{ ...closed, sector: null, shift: null, level: null }]);
    renderSection();
    expect(await screen.findByText('Sem setor')).toBeInTheDocument();
    expect(screen.getByText('Sem turno')).toBeInTheDocument();
    expect(screen.getByText('Sem nível')).toBeInTheDocument();
  });
});

describe('Vínculos da pessoa: lista vazia e erro', () => {
  it('sem vínculos mostra "Nenhum vínculo registrado."', async () => {
    respondWith([]);
    renderSection();
    expect(await screen.findByText('Nenhum vínculo registrado.')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('erro mostra "Não foi possível carregar os vínculos."', async () => {
    const response = new Response(JSON.stringify({ code: 'internal', detail: 'stack interno' }), { status: 500 });
    const error = new HTTPError(response, new Request('https://x'), {} as never);
    mocks.get.mockReturnValue({ json: () => Promise.reject(error) });
    renderSection();
    expect(await screen.findByRole('alert')).toHaveTextContent('Não foi possível carregar os vínculos.');
    expect(screen.queryByText('stack interno')).not.toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
});
