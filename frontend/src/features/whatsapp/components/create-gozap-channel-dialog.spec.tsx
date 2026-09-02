import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CreateGozapChannelDialog } from './create-gozap-channel-dialog';

const mutateAsync = vi.fn();
vi.mock('../api', () => ({
  useCreateGozapChannel: () => ({ mutateAsync, isPending: false }),
}));

vi.mock('@/lib/api-error', () => ({
  extractApiError: vi.fn(async (err: unknown) => ({
    title: err instanceof Error ? err.message : 'Erro',
    message: 'detalhe técnico',
  })),
}));

beforeEach(() => {
  mutateAsync.mockReset();
});

describe('CreateGozapChannelDialog', () => {
  it('shows the plan-limit warning (1 instância no plano Básico)', () => {
    render(
      <CreateGozapChannelDialog open={true} onOpenChange={() => {}} onCreated={() => {}} />,
    );
    expect(screen.getByText('Atenção: o plano permite só 1 instância')).toBeInTheDocument();
    expect(screen.getByText(/plano Básico/i)).toBeInTheDocument();
  });

  it('keeps "Criar canal" disabled until the risk checkbox is checked', async () => {
    render(
      <CreateGozapChannelDialog open={true} onOpenChange={() => {}} onCreated={() => {}} />,
    );
    await userEvent.type(screen.getByLabelText('Nome de exibição'), 'Loja 1');
    const submit = screen.getByRole('button', { name: /Criar canal/i });
    expect(submit).toBeDisabled();

    await userEvent.click(screen.getByRole('checkbox'));
    expect(submit).toBeEnabled();
  });

  it('submits ONLY { name } — GOZAP has no phone/account fields to send', async () => {
    mutateAsync.mockResolvedValue({ id: 'ch1', name: 'Loja 1' });
    const onCreated = vi.fn();
    render(
      <CreateGozapChannelDialog open={true} onOpenChange={() => {}} onCreated={onCreated} />,
    );

    await userEvent.type(screen.getByLabelText('Nome de exibição'), 'Loja 1');
    await userEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: /Criar canal/i }));

    await waitFor(() => expect(mutateAsync).toHaveBeenCalledWith({ name: 'Loja 1' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith({ id: 'ch1', name: 'Loja 1' }));
  });

  it('has no phone number or account id field — unlike Twilio/Zernio', () => {
    render(
      <CreateGozapChannelDialog open={true} onOpenChange={() => {}} onCreated={() => {}} />,
    );
    expect(screen.queryByLabelText(/Número/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/ID da conta/i)).not.toBeInTheDocument();
  });

  it('blocks submit and shows an inline hint for a too-short name', async () => {
    render(
      <CreateGozapChannelDialog open={true} onOpenChange={() => {}} onCreated={() => {}} />,
    );
    await userEvent.type(screen.getByLabelText('Nome de exibição'), 'A');
    await userEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: /Criar canal/i }));

    await waitFor(() => expect(screen.getByText(/Nome muito curto/i)).toBeInTheDocument());
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it('shows the backend PT-BR message inline when creation fails (e.g. duplicate name)', async () => {
    mutateAsync.mockRejectedValue(
      new Error('Já existe um canal GoZap ativo chamado "Loja 1".'),
    );
    render(
      <CreateGozapChannelDialog open={true} onOpenChange={() => {}} onCreated={() => {}} />,
    );
    await userEvent.type(screen.getByLabelText('Nome de exibição'), 'Loja 1');
    await userEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: /Criar canal/i }));

    await waitFor(() =>
      expect(
        screen.getByText('Já existe um canal GoZap ativo chamado "Loja 1".'),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByText('detalhe técnico')).not.toBeInTheDocument();
  });
});
