import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HTTPError } from 'ky';
import type { ConversationSummary } from '../schemas';

const sendFn = vi.fn();
const mediaFn = vi.fn();
const assignMutate = vi.fn();
const typingFn = vi.fn();
let conversation: ConversationSummary | undefined;
let updatedAt = 1;
vi.mock('../api', async () => {
  const { useMutation } = await import('@tanstack/react-query');
  return {
    useSendReply: () => useMutation({ mutationFn: (v: unknown) => sendFn(v) as Promise<unknown> }),
    useSendMedia: () => useMutation({ mutationFn: (v: unknown) => mediaFn(v) as Promise<unknown> }),
    useTyping: () => ({ mutate: typingFn }),
    useConversation: () => ({ data: conversation, dataUpdatedAt: updatedAt }),
    useAssignConversation: () => ({ mutate: assignMutate, isPending: false }),
  };
});
vi.mock('@/features/whatsapp/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/whatsapp/api')>()),
  useProviderInfo: () => undefined,
}));
vi.mock('@/stores/auth.store', () => ({ useAuthStore: (sel: (s: unknown) => unknown) => sel({ user: { id: 'me' } }) }));
import { MessageComposer } from './message-composer';

/** HTTPError no formato do ky 2: corpo já lido em `data`. */
function conflictError(detail?: string): HTTPError {
  const err = Object.create(HTTPError.prototype) as HTTPError;
  const data = { code: 'chat.assigned_to_other', title: 'Conflito', status: 409, detail };
  Object.assign(err, { name: 'HTTPError', message: 'status 409', data, response: { status: 409 } });
  return err;
}
const ana = JSON.stringify({ assignee: { id: 'u2', name: 'Ana', active: true } });

/** 409 sem `data`, com o corpo lido do Response depois de um ciclo do relógio: expõe o intervalo antes da classificação. */
function slowConflictError(detail: string): HTTPError {
  const err = conflictError(detail);
  const body: unknown = err.data;
  const json = () => new Promise((resolve) => setTimeout(() => resolve(body), 30));
  Object.assign(err, { data: undefined, response: { status: 409, clone: () => ({ json }) } });
  return err;
}

/** Observa o DOM e devolve, ao parar, se `text` apareceu em algum momento (não só no estado final). */
function watchFor(text: string): () => boolean {
  let seen = false;
  const observer = new MutationObserver((records) => {
    seen ||= records.some((r) => [...r.addedNodes].some((n) => n.textContent?.includes(text)));
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  return () => { observer.disconnect(); return seen; };
}

function mk(extra: Partial<ConversationSummary>): ConversationSummary {
  return {
    id: 'c1', instanceId: 'i1', instanceName: 'Número A', remoteJid: 'c1@s.whatsapp.net', phoneE164: null,
    contactId: null, displayName: 'Cli', waName: null, profilePicUrl: null, lastMessageAt: null,
    lastMessagePreview: null, lastMessageDirection: null, unreadCount: 0, ...extra,
  } as ConversationSummary;
}
const ofOther = () => mk({ assignedUserId: 'u2', assignedUserName: 'Ana', assignedUserActive: true, status: 'IN_PROGRESS' });

function view() {
  const client = new QueryClient();
  // Elemento novo a cada chamada: o mesmo elemento faria o React pular o re-render.
  const ui = () => (
    <QueryClientProvider client={client}>
      <MessageComposer conversationId="c1" reply={null} onClearReply={() => {}} />
    </QueryClientProvider>
  );
  const utils = render(ui());
  return { ...utils, again: () => utils.rerender(ui()) };
}
const box = () => screen.getByPlaceholderText('Escreva uma mensagem…') as HTMLTextAreaElement;
const sendButton = () => screen.getByLabelText('Enviar') as HTMLButtonElement;
const attachButton = () => screen.getByLabelText('Anexar') as HTMLButtonElement;
const lockNotice = () => screen.queryByText('Ana está atendendo esta conversa.');

beforeEach(() => {
  sendFn.mockReset().mockResolvedValue({ id: 'm1' });
  mediaFn.mockReset().mockResolvedValue({ id: 'm2' });
  assignMutate.mockReset();
  typingFn.mockReset();
  conversation = undefined;
  updatedAt = 1;
});

/** Conversa Pendente cujo envio de texto recebe `err`; espera o aviso da trava. */
async function conflictOnSend(err: HTTPError) {
  conversation = mk({ status: 'PENDING' });
  sendFn.mockRejectedValueOnce(err);
  view();
  fireEvent.change(box(), { target: { value: 'olá' } });
  fireEvent.click(sendButton());
  await waitFor(() => expect(lockNotice()).toBeTruthy());
}

describe('MessageComposer travado não emite "digitando"', () => {
  it('conversa de outro: digitar não chama typing e o texto fica no campo', () => {
    conversation = ofOther();
    view();
    fireEvent.change(box(), { target: { value: 'oi' } });
    expect(box().value).toBe('oi');
    expect(typingFn).not.toHaveBeenCalled();
  });

  it('conversa minha: digitar emite composing como antes', () => {
    conversation = mk({ assignedUserId: 'me', assignedUserName: 'Eu', assignedUserActive: true, status: 'IN_PROGRESS' });
    view();
    fireEvent.change(box(), { target: { value: 'oi' } });
    expect(typingFn).toHaveBeenCalledWith('composing');
  });

  it('depois do 409 local: apagar ainda solta o paused, mas digitar de novo não emite composing', async () => {
    await conflictOnSend(conflictError(ana));
    fireEvent.change(box(), { target: { value: '' } });
    fireEvent.change(box(), { target: { value: 'de novo' } });
    expect(box().value).toBe('de novo');
    expect(typingFn.mock.calls.map(([state]: unknown[]) => state)).toEqual(['composing', 'paused']);
  });
});

describe('MessageComposer 409 sem o aviso genérico em nenhum momento', () => {
  it('texto: "Falha ao enviar" nunca entra no DOM enquanto o corpo do 409 é lido', async () => {
    const stop = watchFor('Falha ao enviar');
    await conflictOnSend(slowConflictError(ana));
    expect(stop()).toBe(false);
  });

  it('mídia: "Falha ao enviar o arquivo" nunca entra no DOM', async () => {
    conversation = mk({ status: 'PENDING' });
    mediaFn.mockRejectedValueOnce(slowConflictError(ana));
    view();
    const stop = watchFor('Falha ao enviar');
    fireEvent.change(screen.getByTestId('chat-file-input'), { target: { files: [new File(['x'], 'a.png', { type: 'image/png' })] } });
    await waitFor(() => expect(lockNotice()).toBeTruthy());
    expect(stop()).toBe(false);
  });

  it('outra falha segue mostrando o aviso genérico depois de classificada', async () => {
    conversation = mk({ status: 'PENDING' });
    sendFn.mockRejectedValueOnce(new Error('rede'));
    view();
    fireEvent.change(box(), { target: { value: 'olá' } });
    fireEvent.click(sendButton());
    expect(await screen.findByText('Falha ao enviar. Tente novamente.')).toBeTruthy();
    expect(box().value).toBe('olá');
  });
});

describe('MessageComposer Assumir depois do 409 local', () => {
  it('manda expectedAssigneeId = id do detail do 409', async () => {
    await conflictOnSend(conflictError(ana));
    fireEvent.click(screen.getByRole('button', { name: 'Assumir conversa' }));
    expect(assignMutate).toHaveBeenCalledWith({ userId: 'me', expectedAssigneeId: 'u2' }, expect.anything());
  });
});

describe('MessageComposer travado quando outro atende', () => {
  it('aceite 6: conversa de outro — aviso, textarea editável, Enviar e clipe desligados, Enter não envia', () => {
    conversation = ofOther();
    view();
    expect(lockNotice()).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Assumir conversa' })).toBeTruthy();
    expect(box().disabled).toBe(false);
    fireEvent.change(box(), { target: { value: 'oi' } });
    expect(box().value).toBe('oi');
    expect(sendButton().disabled).toBe(true);
    expect(attachButton().disabled).toBe(true);
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(sendFn).not.toHaveBeenCalled();
  });

  it('nome inativo: aviso com (inativo)', () => {
    conversation = mk({ assignedUserId: 'u2', assignedUserName: 'Ana', assignedUserActive: false, status: 'IN_PROGRESS' });
    view();
    expect(screen.getByText('Ana (inativo) está atendendo esta conversa.')).toBeTruthy();
  });

  it('Pendente e Resolvida — envio liberado', () => {
    conversation = mk({ status: 'PENDING' });
    const { again } = view();
    fireEvent.change(box(), { target: { value: 'oi' } });
    expect(lockNotice()).toBeNull();
    expect(sendButton().disabled).toBe(false);
    expect(attachButton().disabled).toBe(false);
    conversation = mk({ assignedUserId: 'u2', assignedUserName: 'Ana', status: 'RESOLVED', resolvedAt: '2026-11-21T10:00:00Z' });
    again();
    expect(screen.queryByRole('button', { name: 'Assumir conversa' })).toBeNull();
    expect(sendButton().disabled).toBe(false);
  });
});

describe('MessageComposer 409 chat.assigned_to_other', () => {
  it('aceite 6: 409 no envio — aviso com o nome do detail, texto mantido, sem o aviso genérico de falha', async () => {
    conversation = mk({ status: 'PENDING' });
    sendFn.mockRejectedValueOnce(conflictError(ana));
    view();
    fireEvent.change(box(), { target: { value: 'olá' } });
    fireEvent.click(sendButton());
    await waitFor(() => expect(lockNotice()).toBeTruthy());
    expect(box().value).toBe('olá');
    expect(sendButton().disabled).toBe(true);
    expect(screen.queryByText('Falha ao enviar. Tente novamente.')).toBeNull();
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(sendFn).toHaveBeenCalledTimes(1);
  });

  it('409 na mídia — mesmo aviso, e o clipe fica desligado', async () => {
    conversation = mk({ status: 'PENDING' });
    mediaFn.mockRejectedValueOnce(conflictError(ana));
    view();
    fireEvent.change(screen.getByTestId('chat-file-input'), { target: { files: [new File(['x'], 'a.png', { type: 'image/png' })] } });
    await waitFor(() => expect(lockNotice()).toBeTruthy());
    expect(attachButton().disabled).toBe(true);
    expect(screen.queryByText('Falha ao enviar o arquivo. Tente novamente.')).toBeNull();
  });

  it('conversa recarregada com outro estado solta o 409 local; sem detail o aviso é genérico', async () => {
    conversation = mk({ status: 'PENDING' });
    sendFn.mockRejectedValueOnce(conflictError(undefined));
    const { again } = view();
    fireEvent.change(box(), { target: { value: 'olá' } });
    fireEvent.click(sendButton());
    await waitFor(() => expect(screen.getByText('Outra pessoa está atendendo esta conversa.')).toBeTruthy());
    updatedAt = 2;
    again();
    expect(screen.queryByRole('button', { name: 'Assumir conversa' })).toBeNull();
    expect(sendButton().disabled).toBe(false);
    expect(box().value).toBe('olá');
  });
});

describe('MessageComposer Assumir conversa', () => {
  it('aceite 6: manda userId = eu e expected = atendente; sucesso libera Enviar com o texto', async () => {
    conversation = ofOther();
    assignMutate.mockImplementation((_input: unknown, opts?: { onSuccess?: () => void }) => opts?.onSuccess?.());
    const { again } = view();
    fireEvent.change(box(), { target: { value: 'olá' } });
    fireEvent.click(screen.getByRole('button', { name: 'Assumir conversa' }));
    expect(assignMutate).toHaveBeenCalledWith({ userId: 'me', expectedAssigneeId: 'u2' }, expect.anything());
    conversation = mk({ assignedUserId: 'me', assignedUserName: 'Eu', assignedUserActive: true, status: 'IN_PROGRESS' });
    updatedAt = 2;
    again();
    expect(lockNotice()).toBeNull();
    expect(box().value).toBe('olá');
    expect(sendButton().disabled).toBe(false);
  });
});
