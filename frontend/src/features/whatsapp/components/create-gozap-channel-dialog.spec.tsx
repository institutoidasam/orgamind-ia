import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HTTPError } from 'ky';
import { CreateGozapChannelDialog } from './create-gozap-channel-dialog';

const mutateAsync = vi.fn();
vi.mock('../api', () => ({
  useCreateGozapChannel: () => ({ mutateAsync, isPending: false }),
}));

beforeEach(() => {
  mutateAsync.mockReset();
});

/**
 * A recusa como o ky 2 entrega de verdade: o corpo (ProblemDetails do
 * DomainExceptionFilter, mensagem PT-BR em `title`) já foi consumido e está
 * parseado em `HTTPError.data` — `response.clone()` lançaria. Montar o erro
 * com o corpo intacto esconderia o defeito de quem ainda lê o Response.
 */
async function ky2Error(status: number, code: string, title: string) {
  const response = new Response(
    JSON.stringify({ type: `urn:picoa:error:${code}`, title, status, code }),
    { status, headers: { 'content-type': 'application/problem+json' } },
  );
  const error = new HTTPError(
    response,
    new Request('http://localhost/whatsapp/channels', { method: 'POST' }),
    {} as never,
  );
  error.data = await response.json();
  return error;
}

type OnCreated = Parameters<typeof CreateGozapChannelDialog>[0]['onCreated'];

function renderDialog(onCreated: OnCreated = () => {}) {
  render(<CreateGozapChannelDialog open={true} onOpenChange={() => {}} onCreated={onCreated} />);
}

async function fillAndSubmit(name: string) {
  await userEvent.type(screen.getByLabelText('Nome de exibição'), name);
  await userEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: /Criar canal/i }));
}

describe('CreateGozapChannelDialog', () => {
  it('shows the plan-limit warning (1 instância no plano Básico)', () => {
    renderDialog();
    expect(screen.getByText('Atenção: o plano permite só 1 instância')).toBeInTheDocument();
    expect(screen.getByText(/plano Básico/i)).toBeInTheDocument();
  });

  it('keeps "Criar canal" disabled until the risk checkbox is checked', async () => {
    renderDialog();
    await userEvent.type(screen.getByLabelText('Nome de exibição'), 'Loja 1');
    const submit = screen.getByRole('button', { name: /Criar canal/i });
    expect(submit).toBeDisabled();

    await userEvent.click(screen.getByRole('checkbox'));
    expect(submit).toBeEnabled();
  });

  it('submits ONLY { name } — GOZAP has no phone/account fields to send', async () => {
    mutateAsync.mockResolvedValue({ id: 'ch1', name: 'Loja 1' });
    const onCreated = vi.fn();
    renderDialog(onCreated);

    await fillAndSubmit('Loja 1');

    await waitFor(() => expect(mutateAsync).toHaveBeenCalledWith({ name: 'Loja 1' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith({ id: 'ch1', name: 'Loja 1' }));
  });

  it('has no phone number or account id field — unlike Twilio/Zernio', () => {
    renderDialog();
    expect(screen.queryByLabelText(/Número/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/ID da conta/i)).not.toBeInTheDocument();
  });

  it('blocks submit and shows an inline hint for a too-short name', async () => {
    renderDialog();
    await fillAndSubmit('A');

    await waitFor(() => expect(screen.getByText(/Nome muito curto/i)).toBeInTheDocument());
    expect(mutateAsync).not.toHaveBeenCalled();
  });
});

// O backend confere a vaga do plano GoZap antes de criar a instância (fix
// 23/10/2026). Toda recusa mostra a frase PT-BR do backend no alerta inline.
describe('CreateGozapChannelDialog — recusa do backend no alerta inline', () => {
  it.each([
    [
      409,
      'gozap.instance_limit_reached',
      'A conta GoZap já usa 1 de 1 instância(s) do plano: robo (desconectada). Para conectar um número novo, remova uma conexão que não é mais usada ou aumente o plano do GoZap.',
    ],
    [
      502,
      'gozap.capacity_check_failed',
      'Não foi possível consultar as vagas da conta GoZap. Tente de novo em alguns minutos.',
    ],
    [400, 'gozap.duplicate_name', 'Já existe um canal GoZap ativo chamado "Loja 1".'],
    [502, 'gozap.creation_failed', 'GoZap recusou a criação da instância "Loja 1": HTTP 502'],
  ])('%s %s → mostra a mensagem do backend', async (status, code, title) => {
    mutateAsync.mockRejectedValue(await ky2Error(status, code, title));
    renderDialog();
    await fillAndSubmit('Loja 1');

    expect(await screen.findByText(title)).toBeInTheDocument();
    expect(screen.getByText('Não foi possível criar o canal')).toBeInTheDocument();
    expect(screen.queryByText(/Falha HTTP/)).not.toBeInTheDocument();
  });
});

describe('CreateGozapChannelDialog — fechar', () => {
  it('Cancelar fecha o diálogo e desfaz a confirmação de risco', async () => {
    const onOpenChange = vi.fn();
    render(
      <CreateGozapChannelDialog open={true} onOpenChange={onOpenChange} onCreated={() => {}} />,
    );
    await userEvent.click(screen.getByRole('checkbox'));
    expect(screen.getByRole('checkbox')).toBeChecked();

    await userEvent.click(screen.getByRole('button', { name: 'Cancelar' }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(screen.getByRole('checkbox')).not.toBeChecked();
  });
});
