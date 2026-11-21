import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HTTPError } from 'ky';

const get = vi.fn();
const post = vi.fn();
vi.mock('@/lib/api-client', () => ({ api: { get: (...a: unknown[]) => get(...a), post: (...a: unknown[]) => post(...a) } }));
const toastError = vi.fn();
vi.mock('sonner', () => ({ toast: { error: (...a: unknown[]) => toastError(...a), success: vi.fn() } }));

import { useAssignConversation } from '../api';
import { TransferMenu } from './transfer-menu';

const ASSIGNEES = {
  items: [
    { id: 'u1', name: 'Atendente A' },
    { id: 'u2', name: 'Eu Mesmo' },
    { id: 'u3', name: 'Pessoa C' },
  ],
};

/** HTTPError no formato do ky 2: corpo já lido em `data`. */
function httpError(body: unknown, status: number): HTTPError {
  const err = Object.create(HTTPError.prototype) as HTTPError;
  Object.assign(err, { name: 'HTTPError', message: `status ${status}`, data: body, response: { status } });
  return err;
}

/** Mesma ligação de `ConversationActions`: a mutação de atribuição da conversa c1. */
function Harness() {
  const assign = useAssignConversation('c1');
  return <TransferMenu assignedUserId="u1" meId="u2" disabled={assign.isPending} onTransfer={(i) => assign.mutate(i)} />;
}

async function openMenu() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <Harness />
    </QueryClientProvider>,
  );
  await userEvent.click(screen.getByRole('button', { name: 'Transferir' }));
}

beforeEach(() => {
  get.mockReset().mockReturnValue({ json: () => Promise.resolve(ASSIGNEES) });
  post.mockReset().mockResolvedValue({});
  toastError.mockReset();
});

describe('TransferMenu — destinos', () => {
  it('aceite 8: lista de chat/assignees sem o atendente atual e sem quem olha; nenhuma chamada a /users', async () => {
    await openMenu();
    expect(await screen.findByRole('menuitem', { name: 'Pessoa C' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Atendente A' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Eu Mesmo' })).toBeNull();
    expect(get.mock.calls.map((c) => c[0])).toEqual(['chat/assignees']);
  });
});

describe('TransferMenu — transferir', () => {
  it('escolher abre o diálogo Transferir para {nome} e manda a observação', async () => {
    await openMenu();
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Pessoa C' }));
    expect(await screen.findByRole('dialog', { name: 'Transferir para Pessoa C' })).toBeInTheDocument();
    expect(post).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('Observação (opcional)'), { target: { value: 'turno acabou' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('chat/conversations/c1/assign', {
      json: { userId: 'u3', expectedAssigneeId: 'u1', note: 'turno acabou' },
    }));
  });

  it('404 user.not_found — Esta pessoa não pode receber a conversa. Escolha outra.', async () => {
    post.mockRejectedValue(httpError({ code: 'user.not_found' }, 404));
    await openMenu();
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Pessoa C' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirmar' }));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('Esta pessoa não pode receber a conversa. Escolha outra.'));
  });
});
