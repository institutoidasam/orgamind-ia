import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const get = vi.fn();
vi.mock('@/lib/api-client', () => ({ api: { get: (...a: unknown[]) => get(...a) } }));

import { ConversationHistory } from './conversation-history';

const json = (value: unknown) => ({ json: () => Promise.resolve(value) });
const failing = () => ({ json: () => Promise.reject(new Error('falhou')) });

function row(id: string, over: Record<string, unknown> = {}) {
  return {
    id, action: 'ASSUMED', createdAt: '2026-11-21T18:30:00.000Z',
    actorId: 'u1', actorName: 'Ana',
    fromUserId: null, fromUserName: null, toUserId: null, toUserName: null, note: null,
    ...over,
  };
}

function renderHistory() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ConversationHistory conversationId="c1" />
    </QueryClientProvider>,
  );
}

const open = () => fireEvent.click(screen.getByRole('button', { name: /Histórico da conversa/ }));

beforeEach(() => get.mockReset());

describe('ConversationHistory — abrir e carregar', () => {
  it('fechado — nenhuma chamada; abrir busca chat/conversations/:id/history', async () => {
    let resolve!: (v: unknown) => void;
    get.mockReturnValue({ json: () => new Promise((r) => { resolve = r; }) });
    renderHistory();
    expect(get).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /Histórico da conversa/ })).toHaveAttribute('aria-expanded', 'false');

    open();
    expect(screen.getByText('Carregando histórico…')).toBeInTheDocument();
    await waitFor(() => expect(get).toHaveBeenCalledWith('chat/conversations/c1/history'));
    resolve({ items: [] });
    expect(await screen.findByText('Nenhuma mudança registrada.')).toBeInTheDocument();
  });

  it('linhas na ordem da resposta com Observação: …', async () => {
    get.mockReturnValue(json({
      items: [
        row('h2', { action: 'RESOLVED', createdAt: '2026-11-21T19:00:00.000Z', note: 'cliente satisfeito' }),
        row('h1', { action: 'REOPENED', createdAt: '2026-11-21T18:30:00.000Z', actorId: null, actorName: null }),
      ],
    }));
    renderHistory();
    open();
    await screen.findAllByRole('listitem');
    const lines = screen.getAllByTestId('history-line').map((el) => el.textContent);
    expect(lines).toEqual([
      '21/11 15:00 · Ana resolveu a conversa',
      '21/11 14:30 · Sistema reabriu a conversa (nova mensagem recebida)',
    ]);
    const [first, second] = screen.getAllByRole('listitem');
    expect(within(first).getByText('Observação: cliente satisfeito')).toBeInTheDocument();
    expect(within(second).queryByText(/Observação/)).toBeNull();
  });

  it('vazio — Nenhuma mudança registrada.', async () => {
    get.mockReturnValue(json({ items: [] }));
    renderHistory();
    open();
    expect(await screen.findByText('Nenhuma mudança registrada.')).toBeInTheDocument();
    expect(screen.queryByRole('listitem')).toBeNull();
  });
});

describe('ConversationHistory — erro e limite', () => {
  it('erro — Não foi possível carregar o histórico e Tentar de novo', async () => {
    get.mockReturnValueOnce(failing()).mockReturnValue(json({ items: [row('h1')] }));
    renderHistory();
    open();
    expect(await screen.findByText('Não foi possível carregar o histórico')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    expect(await screen.findByText('21/11 14:30 · Ana assumiu a conversa')).toBeInTheDocument();
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('M8: hasMore verdadeiro — rodapé "Mostrando as 200 mudanças mais recentes."; sem hasMore ou falso — sem rodapé', async () => {
    get.mockReturnValue(json({ items: [row('h1')], hasMore: true }));
    const { unmount } = renderHistory();
    open();
    expect(await screen.findByText('Mostrando as 200 mudanças mais recentes.')).toBeInTheDocument();
    unmount();

    for (const body of [{ items: [row('h1')], hasMore: false }, { items: [row('h1')] }]) {
      get.mockReturnValue(json(body));
      const view = renderHistory();
      open();
      await screen.findByText('21/11 14:30 · Ana assumiu a conversa');
      expect(screen.queryByText('Mostrando as 200 mudanças mais recentes.')).toBeNull();
      view.unmount();
    }
  });
});

describe('ConversationHistory — acessibilidade (Fix R1)', () => {
  it('o botão aponta (aria-controls) para o corpo da seção, que recebe as linhas ao abrir', async () => {
    get.mockReturnValue(json({ items: [row('h1')] }));
    renderHistory();
    const controls = screen.getByRole('button', { name: /Histórico da conversa/ }).getAttribute('aria-controls');
    expect(controls).toBeTruthy();
    open();
    await screen.findAllByRole('listitem');
    expect(document.getElementById(controls ?? '')).toContainElement(screen.getByRole('list'));
  });
});
