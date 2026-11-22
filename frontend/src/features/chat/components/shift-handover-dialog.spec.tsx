import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const get = vi.fn();
const post = vi.fn();
vi.mock('@/lib/api-client', () => ({ api: { get: (...a: unknown[]) => get(...a), post: (...a: unknown[]) => post(...a) } }));
const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock('sonner', () => ({ toast: { success: (...a: unknown[]) => toastSuccess(...a), error: (...a: unknown[]) => toastError(...a) } }));

import { useAuthStore } from '@/stores/auth.store';
import { ShiftHandoverDialog } from './shift-handover-dialog';
import { HANDOVER_ASSIGNEES, HANDOVER_CONVS, httpError, json, routeGet } from './shift-handover.test-fixtures';

// Radix Select (shadcn) usa PointerEvents/scrollIntoView, que o jsdom não tem.
if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false;
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};

const NOTE = 'fim do turno, retomar amanhã';

function renderDialog() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const onClose = vi.fn();
  render(
    <QueryClientProvider client={qc}>
      <ShiftHandoverDialog open title="Passar meu turno" fromId="u1" onClose={onClose} />
    </QueryClientProvider>,
  );
  return { qc, onClose, user: userEvent.setup() };
}

type User = ReturnType<typeof userEvent.setup>;
const confirmButton = () => screen.getByRole('button', { name: 'Confirmar' });
const typeNote = (value: string) => fireEvent.change(screen.getByLabelText('Observação'), { target: { value } });

async function pickTarget(user: User, name: string) {
  await user.click(await screen.findByRole('combobox', { name: 'Passar para' }));
  await user.click(await screen.findByRole('option', { name }));
}

/** Espera a lista, escolhe o destino e escreve a observação: o pedido fica pronto para Confirmar. */
async function fillRequest(user: User, target = 'Pessoa B') {
  await screen.findByRole('checkbox', { name: 'Maria' });
  await pickTarget(user, target);
  typeNote(NOTE);
}

beforeEach(() => {
  get.mockReset().mockImplementation(routeGet(HANDOVER_CONVS));
  post.mockReset().mockReturnValue(json({ transferred: [{ id: 'c2' }], skipped: [] }));
  toastSuccess.mockReset();
  toastError.mockReset();
  useAuthStore.setState({ user: { id: 'u1', email: 'a@x.com', name: 'Atendente A', role: 'OPERATOR' } });
});

describe('ShiftHandoverDialog — pedido', () => {
  it('aceite 25: todas marcadas; desmarcar tira do pedido', async () => {
    const { user, onClose } = renderDialog();
    const maria = await screen.findByRole('checkbox', { name: 'Maria' });
    expect(maria).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'João' })).toBeChecked();
    expect(screen.queryByText(/Mostrando/)).toBeNull();
    expect(get).toHaveBeenCalledWith('chat/conversations?status=open&assignee=u1&pageSize=100');
    await user.click(maria);
    expect(maria).not.toBeChecked();
    await pickTarget(user, 'Pessoa B');
    typeNote(NOTE);
    await user.click(confirmButton());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(post).toHaveBeenCalledWith('chat/handover', { json: { toUserId: 'u2', note: NOTE, conversationIds: ['c2'] } });
    expect(toastSuccess).toHaveBeenCalledWith('1 conversa passada para Pessoa B.');
  });

  it('Confirmar desligado sem marcada, sem destino ou sem observação; 200 no máximo', async () => {
    const { user } = renderDialog();
    const maria = await screen.findByRole('checkbox', { name: 'Maria' });
    expect(confirmButton()).toBeDisabled();
    await pickTarget(user, 'Pessoa B');
    expect(confirmButton()).toBeDisabled();
    typeNote('   ');
    expect(confirmButton()).toBeDisabled();
    typeNote('x'.repeat(250));
    expect(screen.getByLabelText('Observação')).toHaveValue('x'.repeat(200));
    expect(confirmButton()).toBeEnabled();
    await user.click(maria);
    await user.click(screen.getByRole('checkbox', { name: 'João' }));
    expect(confirmButton()).toBeDisabled();
  });

  it('destinos sem quem sai', async () => {
    const { user } = renderDialog();
    await user.click(await screen.findByRole('combobox', { name: 'Passar para' }));
    const options = await screen.findAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual(['Pessoa B', 'Pessoa C']);
    expect(get).toHaveBeenCalledWith('chat/assignees');
  });
});

describe('ShiftHandoverDialog — lista e resultado', () => {
  it('aceite 25: resultado com puladas — Não foram passadas: e os motivos', async () => {
    post.mockReturnValue(json({
      transferred: [],
      skipped: [{ id: 'c1', reason: 'other_assignee' }, { id: 'c2', reason: 'already_with_target' }],
    }));
    const { user, onClose } = renderDialog();
    await fillRequest(user);
    await user.click(confirmButton());
    expect(await screen.findByText('Não foram passadas:')).toBeInTheDocument();
    expect(screen.getByText('Maria: já com outro atendente')).toBeInTheDocument();
    expect(screen.getByText('João: já estava com Pessoa B')).toBeInTheDocument();
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Fechar' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('acima de 100 — aviso', async () => {
    get.mockImplementation(routeGet(HANDOVER_CONVS, 120));
    renderDialog();
    expect(
      await screen.findByText('Mostrando 2 de 120. Passe estas e abra de novo para passar as demais.'),
    ).toBeInTheDocument();
  });

  it('sem conversas em atendimento — aviso e Confirmar desligado', async () => {
    get.mockImplementation(routeGet([]));
    const { user } = renderDialog();
    expect(await screen.findByText('Nenhuma conversa em atendimento.')).toBeInTheDocument();
    await pickTarget(user, 'Pessoa B');
    typeNote(NOTE);
    expect(confirmButton()).toBeDisabled();
  });
});

describe('ShiftHandoverDialog — erro do servidor', () => {
  it('404 user.not_found — Esta pessoa não pode receber as conversas. Escolha outra.', async () => {
    post.mockReturnValue({ json: () => Promise.reject(httpError({ code: 'user.not_found' }, 404)) });
    const { user, onClose } = renderDialog();
    await fillRequest(user);
    // A recarga dos destinos depois do erro já não traz Pessoa B.
    get.mockImplementation(routeGet(HANDOVER_CONVS, 2, { items: [HANDOVER_ASSIGNEES.items[0], HANDOVER_ASSIGNEES.items[2]] }));
    await user.click(confirmButton());
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith('Esta pessoa não pode receber as conversas. Escolha outra.'),
    );
    expect(onClose).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Passar para' })).toHaveTextContent('Escolha um colega'),
    );
    expect(confirmButton()).toBeDisabled();
  });
});
