import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HTTPError } from 'ky';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  recipients: vi.fn(),
  retry: vi.fn(),
  success: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
}));

vi.mock('@/features/team-whatsapp/api', () => ({
  useDispatchRecipients: (id: string, args: { status?: string; page: number; q?: string }) => mocks.recipients(id, args),
  useRetryRecipients: () => ({ mutateAsync: mocks.retry, isPending: false }),
}));
vi.mock('sonner', () => ({ toast: { success: mocks.success, info: mocks.info, error: mocks.error } }));

import { useAuthStore, type AuthUser } from '@/stores/auth.store';
import type { DispatchRecipient } from '../schemas';
import { NO_NAME_MATCH_TEXT } from '../name-search';
import { RecipientTable } from './recipient-table';

// Radix Select (shadcn) usa PointerEvents/scrollIntoView, que o jsdom não tem.
if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false;
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};

const row = (over: Partial<DispatchRecipient>): DispatchRecipient => ({
  id: 'r0', userName: 'Pessoa', sectorName: 'Compras', levelName: null, shiftName: null, status: 'SENT', reason: null,
  attempts: 1, channel: { name: 'GoZap Principal', phoneE164: '+5592999990000' }, acceptedAt: null, deliveredAt: null,
  readAt: null, repliedAt: null, repeatable: false, ...over,
});

const ana = row({ id: 'r1', userName: 'Ana', status: 'READ' });
const bia = row({
  id: 'r2', userName: 'Bia', status: 'FAILED', reason: 'team_whatsapp.channel_disconnected', attempts: 3, repeatable: true,
});
const caio = row({
  id: 'r3', userName: 'Caio', status: 'SKIPPED', reason: 'NO_PHONE', attempts: 0, channel: null,
});
const duda = row({
  id: 'r4', userName: 'Duda', status: 'UNCERTAIN', reason: 'team_whatsapp.indeterminate', attempts: 1,
});
const eva = row({
  id: 'r5', userName: 'Eva', status: 'FAILED', reason: 'gozap.not_on_whatsapp', attempts: 1, repeatable: false,
});

function loaded(items: DispatchRecipient[], total = items.length) {
  mocks.recipients.mockReturnValue({
    data: { items, total, page: 1, pageSize: 50 }, isLoading: false, isError: false, refetch: vi.fn(),
  });
}

const rowOf = (name: string) => screen.getByRole('row', { name: new RegExp(name) });

const OPERATOR: AuthUser = { id: 'u1', email: 'o@x.test', name: 'Olga', role: 'OPERATOR' };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.retry.mockResolvedValue({ requeued: 1 });
  loaded([ana, bia, caio, duda, eva]);
  useAuthStore.setState({ user: OPERATOR });
});

describe('RecipientTable: telefone, pulados da reconferência e busca', () => {
  it('Telefone usado mostra o gravado ou — quando o envio é antigo', () => {
    loaded([row({ id: 'a', userName: 'Lia', phone: '+5592991110001' }), row({ id: 'b', userName: 'Teo', phone: null })]);
    render(<RecipientTable dispatchId="d1" failedCount={0} />);
    expect(within(rowOf('Lia')).getAllByRole('cell')[1]).toHaveTextContent('+5592991110001');
    expect(within(rowOf('Teo')).getAllByRole('cell')[1]).toHaveTextContent('—');
  });

  it('aceite 28: PHONE_CHANGED com a dica de envio novo e sem Repetir (mesmo com permissão)', () => {
    useAuthStore.setState({ user: { ...OPERATOR, permissions: ['equipe.enviar'] } });
    loaded([row({ id: 'p', userName: 'Pia', status: 'SKIPPED', reason: 'PHONE_CHANGED', attempts: 0, channel: null })]);
    render(<RecipientTable dispatchId="d1" failedCount={0} />);
    expect(rowOf('Pia')).toHaveTextContent('Pulado: Telefone mudou depois da criação do envio');
    expect(rowOf('Pia')).toHaveTextContent('Para avisar essa pessoa, crie um envio novo.');
    expect(screen.queryByRole('button', { name: 'Repetir' })).not.toBeInTheDocument();
  });

  it('pulado da reconferência mostra o motivo; vencido não repete o prefixo "Pulado:"', () => {
    loaded([
      row({ id: 'f', userName: 'Fia', status: 'SKIPPED', reason: 'VACATION', attempts: 0, channel: null }),
      row({ id: 'e', userName: 'Eli', status: 'SKIPPED', reason: 'EXPIRED', attempts: 0, channel: null }),
    ]);
    render(<RecipientTable dispatchId="d1" failedCount={0} />);
    expect(rowOf('Fia')).toHaveTextContent('Pulado: Férias');
    expect(within(rowOf('Eli')).getAllByRole('cell')[2]).toHaveTextContent(/^Não enviado: passou da hora$/);
  });

  it('aceite 31: a busca vai como q ao servidor e volta para a página 1', async () => {
    loaded([ana], 120);
    const user = userEvent.setup();
    const { rerender } = render(<RecipientTable dispatchId="d1" failedCount={0} />);
    await user.click(screen.getByRole('button', { name: 'Próxima' }));
    expect(mocks.recipients).toHaveBeenLastCalledWith('d1', { status: undefined, page: 2 });
    rerender(<RecipientTable dispatchId="d1" failedCount={0} query="jose" />);
    expect(mocks.recipients).toHaveBeenLastCalledWith('d1', { status: undefined, page: 1, q: 'jose' });
  });
});

describe('RecipientTable: permissão (DB6, DB10)', () => {
  it('sem equipe.enviar some o Repetir da linha e o Repetir todas, e a falha continua visível', () => {
    useAuthStore.setState({ user: { ...OPERATOR, permissions: ['trilha.consultar'] } });
    render(<RecipientTable dispatchId="d1" failedCount={2} />);
    expect(rowOf('Bia')).toHaveTextContent('Falhou: Número desconectado');
    expect(screen.queryByRole('button', { name: 'Repetir' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Repetir todas/ })).not.toBeInTheDocument();
  });

  it('403 auth.permission_denied mostra o detail do servidor no toast', async () => {
    const body = JSON.stringify({ code: 'auth.permission_denied', detail: 'Texto do servidor.' });
    mocks.retry.mockRejectedValue(new HTTPError(new Response(body, { status: 403 }), new Request('https://x'), {} as never));
    render(<RecipientTable dispatchId="d1" failedCount={2} />);
    await userEvent.click(within(rowOf('Bia')).getByRole('button', { name: 'Repetir' }));
    await waitFor(() => expect(mocks.error).toHaveBeenCalledWith('Texto do servidor.'));
  });
});

describe('RecipientTable: colunas', () => {
  it('mostra Nome, Telefone usado, Situação, Número, Tentativas e Motivo; sem tentativa vira —', () => {
    render(<RecipientTable dispatchId="d1" failedCount={2} />);
    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers).toEqual(['Nome', 'Telefone usado', 'Situação', 'Número', 'Tentativas', 'Motivo', 'Ações']);
    const cells = (name: string) => within(rowOf(name)).getAllByRole('cell').map((c) => c.textContent);
    expect(cells('Ana').slice(0, 5)).toEqual(['Ana', '—', 'Lido', '+5592999990000', '1']);
    expect(cells('Bia').slice(0, 6)).toEqual([
      'Bia', '—', 'Falhou: Número desconectado', '+5592999990000', '3', 'team_whatsapp.channel_disconnected',
    ]);
    expect(cells('Caio').slice(0, 6)).toEqual(['Caio', '—', 'Pulado: sem telefone', '—', '—', '—']);
  });

  it('número removido depois do envio mostra o nome do canal ou Número removido', () => {
    loaded([
      row({ id: 'a', userName: 'Lia', channel: { name: 'Comercial', phoneE164: null } }),
      row({ id: 'b', userName: 'Teo', channel: { name: null, phoneE164: null } }),
    ]);
    render(<RecipientTable dispatchId="d1" failedCount={0} />);
    expect(rowOf('Lia')).toHaveTextContent('Comercial');
    expect(rowOf('Teo')).toHaveTextContent('Número removido');
  });
});

describe('RecipientTable: Repetir', () => {
  it('Repetir só aparece na falha repetível e chama retry com o id e o toast', async () => {
    render(<RecipientTable dispatchId="d1" failedCount={2} />);
    expect(screen.getAllByRole('button', { name: 'Repetir' })).toHaveLength(1);
    await userEvent.click(within(rowOf('Bia')).getByRole('button', { name: 'Repetir' }));
    expect(mocks.retry).toHaveBeenCalledWith({ recipientIds: ['r2'] });
    await waitFor(() => expect(mocks.success).toHaveBeenCalledWith('1 mensagem(ns) na fila de novo'));
  });

  it('situação incerta mostra a explicação e nenhum botão', () => {
    render(<RecipientTable dispatchId="d1" failedCount={2} />);
    const duda = rowOf('Duda');
    expect(duda).toHaveTextContent('Situação incerta');
    expect(duda).toHaveTextContent(
      'O WhatsApp não confirmou o envio. A mensagem pode ter saído: confira no celular antes de mandar de novo.',
    );
    expect(within(duda).queryByRole('button')).not.toBeInTheDocument();
  });

  it('Repetir todas as falhas (2) manda all; sem nada para repetir avisa', async () => {
    mocks.retry.mockResolvedValueOnce({ requeued: 2 }).mockResolvedValueOnce({ requeued: 0 });
    render(<RecipientTable dispatchId="d1" failedCount={2} />);
    const all = screen.getByRole('button', { name: 'Repetir todas as falhas (2)' });
    await userEvent.click(all);
    expect(mocks.retry).toHaveBeenCalledWith({ all: true });
    await waitFor(() => expect(mocks.success).toHaveBeenCalledWith('2 mensagem(ns) na fila de novo'));
    await userEvent.click(all);
    await waitFor(() => expect(mocks.info).toHaveBeenCalledWith('Nada para repetir'));
  });

  it('sem falhas não mostra o botão de repetir todas', () => {
    render(<RecipientTable dispatchId="d1" failedCount={0} />);
    expect(screen.queryByRole('button', { name: /Repetir todas/ })).not.toBeInTheDocument();
  });

  it('erro ao repetir mostra a mensagem do servidor num toast', async () => {
    const body = JSON.stringify({ code: 'team_whatsapp.forbidden' });
    mocks.retry.mockRejectedValue(new HTTPError(new Response(body, { status: 403 }), new Request('https://x'), {} as never));
    render(<RecipientTable dispatchId="d1" failedCount={2} />);
    await userEvent.click(within(rowOf('Bia')).getByRole('button', { name: 'Repetir' }));
    await waitFor(() => expect(mocks.error).toHaveBeenCalledWith('Você não tem permissão para enviar a este destino.'));
  });
});

describe('RecipientTable: filtro e páginas', () => {
  it('filtro Situação = Lido pede status READ na página 1, mesmo vindo da página 2; Todas limpa', async () => {
    loaded([ana], 120);
    const user = userEvent.setup();
    render(<RecipientTable dispatchId="d1" failedCount={0} />);
    expect(mocks.recipients).toHaveBeenLastCalledWith('d1', { status: undefined, page: 1 });
    await user.click(screen.getByRole('button', { name: 'Próxima' }));
    expect(mocks.recipients).toHaveBeenLastCalledWith('d1', { status: undefined, page: 2 });
    await user.click(screen.getByRole('combobox', { name: 'Situação' }));
    expect(screen.getByRole('option', { name: 'Todas' })).toBeInTheDocument();
    await user.click(screen.getByRole('option', { name: 'Lido' }));
    expect(mocks.recipients).toHaveBeenLastCalledWith('d1', { status: 'READ', page: 1 });
    await user.click(screen.getByRole('button', { name: 'Próxima' }));
    await user.click(screen.getByRole('combobox', { name: 'Situação' }));
    await user.click(screen.getByRole('option', { name: 'Todas' }));
    expect(mocks.recipients).toHaveBeenLastCalledWith('d1', { status: undefined, page: 1 });
  });

  it('filtro sem resultado mostra o vazio; erro mostra Tentar novamente', async () => {
    loaded([]);
    const { rerender } = render(<RecipientTable dispatchId="d1" failedCount={0} />);
    expect(screen.getByText('Nenhum destinatário nesta situação.')).toBeInTheDocument();
    const refetch = vi.fn();
    const failure = new HTTPError(new Response('{}', { status: 500 }), new Request('https://x'), {} as never);
    mocks.recipients.mockReturnValue({ data: undefined, isLoading: false, isError: true, error: failure, refetch });
    rerender(<RecipientTable dispatchId="d1" failedCount={0} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Tentar novamente' }));
    expect(refetch).toHaveBeenCalled();
  });
});

describe('RecipientTable: busca por nome sem resultado', () => {
  it('com termo de busca e lista vazia mostra o vazio da busca, não o do filtro de situação', () => {
    loaded([]);
    render(<RecipientTable dispatchId="d1" failedCount={0} query="zzz" />);
    expect(screen.getByText(NO_NAME_MATCH_TEXT)).toBeInTheDocument();
    expect(screen.queryByText('Nenhum destinatário nesta situação.')).not.toBeInTheDocument();
  });
});
