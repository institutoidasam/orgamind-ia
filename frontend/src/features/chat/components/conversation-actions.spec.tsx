import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HTTPError } from 'ky';

const post = vi.fn();
const get = vi.fn();
vi.mock('@/lib/api-client', () => ({ api: { post: (...a: unknown[]) => post(...a), get: (...a: unknown[]) => get(...a) } }));
const toastError = vi.fn();
vi.mock('sonner', () => ({ toast: { error: (...a: unknown[]) => toastError(...a), success: vi.fn() } }));

import { useAuthStore, type AuthUser } from '@/stores/auth.store';
import { ConversationActions } from './conversation-actions';
import type { ConversationSummary } from '../schemas';

const LAST_INBOUND = '2026-11-21T14:00:00.000Z';
const LATER_INBOUND = '2026-11-21T14:05:00.000Z';

function conv(over: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    id: 'c1', instanceId: 'i1', instanceName: 'A', remoteJid: 'x@s.whatsapp.net', phoneE164: '+5592991110001',
    contactId: null, displayName: 'Cliente', waName: null, profilePicUrl: null, lastMessageAt: null,
    lastMessagePreview: null, lastMessageDirection: null, unreadCount: 0,
    assignedUserId: 'u1', assignedUserName: 'Atendente A', assignedUserActive: true,
    status: 'IN_PROGRESS', lastInboundAt: LAST_INBOUND,
    ...over,
  };
}

function loginAs(id: string, role: AuthUser['role']) {
  useAuthStore.setState({ user: { id, email: 'a@x.com', name: 'Eu', role } });
}

function renderActions(c: ConversationSummary) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const ui = (shown: ConversationSummary) => (
    <QueryClientProvider client={qc}>
      <ConversationActions conv={shown} />
    </QueryClientProvider>
  );
  const view = render(ui(c));
  return { qc, ...view, rerenderWith: (shown: ConversationSummary) => view.rerender(ui(shown)) };
}

/** Abre "Transferir", escolhe "Pessoa C" (único destino) e espera o diálogo. */
async function pickTransferTarget() {
  get.mockReturnValue({ json: () => Promise.resolve({ items: [{ id: 'u3', name: 'Pessoa C' }] }) });
  await userEvent.click(screen.getByRole('button', { name: 'Transferir' }));
  await userEvent.click(await screen.findByRole('menuitem', { name: 'Pessoa C' }));
  await screen.findByRole('dialog', { name: 'Transferir para Pessoa C' });
}

const button = (name: string) => screen.queryByRole('button', { name });
const click = (name: string) => fireEvent.click(screen.getByRole('button', { name }));
const typeNote = (text: string) =>
  fireEvent.change(screen.getByLabelText('Observação (opcional)'), { target: { value: text } });

/** HTTPError no formato do ky 2: corpo já lido em `data`. */
function httpError(body: unknown, status: number): HTTPError {
  const err = Object.create(HTTPError.prototype) as HTTPError;
  Object.assign(err, { name: 'HTTPError', message: `status ${status}`, data: body, response: { status } });
  return err;
}

beforeEach(() => {
  post.mockReset().mockResolvedValue({});
  get.mockReset();
  toastError.mockReset();
  loginAs('u1', 'OPERATOR');
});

describe('ConversationActions — botões por papel', () => {
  it('aceite 2: OPERATOR atendente vê Resolver; OPERATOR não atendente não vê', () => {
    const mine = renderActions(conv());
    expect(button('Resolver')).not.toBeNull();
    mine.unmount();

    loginAs('u2', 'OPERATOR');
    renderActions(conv());
    expect(button('Resolver')).toBeNull();
    expect(button('Assumir conversa')).not.toBeNull();
  });

  it('ADMIN vê Resolver em conversa de outro', () => {
    loginAs('u9', 'ADMIN');
    renderActions(conv());
    expect(button('Resolver')).not.toBeNull();
    expect(button('Remover atendente')).not.toBeNull();
  });

  it('aceite 10: atendente inativo — o OPERATOR vê Assumir conversa', () => {
    loginAs('u2', 'OPERATOR');
    renderActions(conv({ assignedUserActive: false }));
    expect(button('Assumir conversa')).not.toBeNull();
  });
});

describe('ConversationActions — Resolver e Reabrir', () => {
  it('Resolver abre o diálogo e manda expectedAssigneeId, expectedLastInboundAt e a observação', async () => {
    renderActions(conv());
    click('Resolver');
    expect(screen.getByRole('dialog', { name: 'Resolver conversa' })).toBeInTheDocument();
    expect(post).not.toHaveBeenCalled();
    typeNote('cliente satisfeito');
    click('Confirmar');
    await waitFor(() => expect(post).toHaveBeenCalledWith('chat/conversations/c1/resolve', {
      json: { expectedAssigneeId: 'u1', expectedLastInboundAt: LAST_INBOUND, note: 'cliente satisfeito' },
    }));
  });

  it('aceite 4: Resolvida — Reabrir com observação', async () => {
    renderActions(conv({ status: 'RESOLVED', resolvedAt: LAST_INBOUND, assignedUserId: null, assignedUserName: null }));
    expect(button('Resolver')).toBeNull();
    click('Reabrir');
    expect(screen.getByRole('dialog', { name: 'Reabrir conversa' })).toBeInTheDocument();
    typeNote('cliente voltou por telefone');
    click('Confirmar');
    await waitFor(() => expect(post).toHaveBeenCalledWith('chat/conversations/c1/reopen', {
      json: { note: 'cliente voltou por telefone' },
    }));
  });
});

describe('ConversationActions — Assumir e Remover', () => {
  it('Assumir conversa — um clique, userId = eu, expected = atendente mostrado', async () => {
    loginAs('u2', 'OPERATOR');
    renderActions(conv());
    click('Assumir conversa');
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(post).toHaveBeenCalledWith('chat/conversations/c1/assign', {
      json: { userId: 'u2', expectedAssigneeId: 'u1' },
    }));
  });

  it('Remover atendente — expected = atendente; Pendente sem o botão', async () => {
    const view = renderActions(conv());
    click('Remover atendente');
    expect(screen.getByRole('dialog', { name: 'Remover atendente' })).toBeInTheDocument();
    click('Confirmar');
    await waitFor(() => expect(post).toHaveBeenCalledWith('chat/conversations/c1/assign', {
      json: { userId: null, expectedAssigneeId: 'u1' },
    }));
    view.unmount();

    renderActions(conv({ status: 'PENDING', assignedUserId: null, assignedUserName: null }));
    expect(button('Remover atendente')).toBeNull();
  });
});

describe('ConversationActions — conversa que mudou', () => {
  it('aceite 3: 409 conversation_changed — toast com o texto e recarga da conversa', async () => {
    post.mockRejectedValue(httpError({ code: 'chat.conversation_changed' }, 409));
    const { qc } = renderActions(conv());
    qc.setQueryData(['chat', 'conversations', 'c1'], conv());
    click('Resolver');
    click('Confirmar');
    await waitFor(() => expect(toastError).toHaveBeenCalledWith(
      'A conversa mudou enquanto você olhava. Ela foi recarregada; confira e tente de novo.',
    ));
    await waitFor(() => expect(qc.getQueryState(['chat', 'conversations', 'c1'])?.isInvalidated).toBe(true));
  });
});

describe('ConversationActions — expected… de quando a ação abriu (Fix R1)', () => {
  it('aceite 3: Resolver manda o que a tela mostrava ao abrir, mesmo se a conversa recarregar; reabrir lê de novo', async () => {
    loginAs('u9', 'ADMIN');
    const view = renderActions(conv());
    click('Resolver');
    view.rerenderWith(conv({ assignedUserId: 'u3', lastInboundAt: LATER_INBOUND }));
    click('Confirmar');
    await waitFor(() => expect(post).toHaveBeenCalledWith('chat/conversations/c1/resolve', {
      json: { expectedAssigneeId: 'u1', expectedLastInboundAt: LAST_INBOUND },
    }));

    click('Resolver');
    click('Confirmar');
    await waitFor(() => expect(post).toHaveBeenLastCalledWith('chat/conversations/c1/resolve', {
      json: { expectedAssigneeId: 'u3', expectedLastInboundAt: LATER_INBOUND },
    }));
  });

  it('aceite 3: Transferir manda o atendente visto ao escolher o destino, mesmo se a conversa recarregar', async () => {
    loginAs('u9', 'ADMIN');
    const view = renderActions(conv());
    await pickTransferTarget();
    view.rerenderWith(conv({ assignedUserId: 'u4', assignedUserName: 'Atendente D' }));
    click('Confirmar');
    await waitFor(() => expect(post).toHaveBeenCalledWith('chat/conversations/c1/assign', {
      json: { userId: 'u3', expectedAssigneeId: 'u1' },
    }));
  });
});

describe('ConversationActions — transferência em andamento (Fix R1)', () => {
  it('com a transferência pendente, Resolver, Assumir, Remover e Transferir ficam desabilitados', async () => {
    loginAs('u9', 'ADMIN');
    post.mockReturnValue(new Promise(() => {}));
    renderActions(conv());
    await pickTransferTarget();
    click('Confirmar');
    await waitFor(() => expect(button('Resolver')).toBeDisabled());
    for (const name of ['Assumir conversa', 'Remover atendente', 'Transferir']) expect(button(name)).toBeDisabled();
  });
});
