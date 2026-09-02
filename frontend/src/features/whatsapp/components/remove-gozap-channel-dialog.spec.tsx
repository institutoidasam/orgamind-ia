import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RemoveGozapChannelDialog } from './remove-gozap-channel-dialog';

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock('sonner', () => ({
  toast: {
    success: (...a: unknown[]) => toastSuccess(...a),
    error: (...a: unknown[]) => toastError(...a),
  },
}));

const mutateAsync = vi.fn();
vi.mock('../api', () => ({
  useDeleteGozapChannel: () => ({ mutateAsync, isPending: false }),
}));

vi.mock('@/lib/api-error', () => ({
  extractApiError: vi.fn(async (err: unknown) => ({
    title: err instanceof Error ? err.message : 'Erro',
    message: 'detalhe técnico',
  })),
}));

const CHANNEL = { id: 'ch1', name: 'Loja 1' };

beforeEach(() => {
  mutateAsync.mockReset();
  toastSuccess.mockReset();
  toastError.mockReset();
});

describe('RemoveGozapChannelDialog', () => {
  it('keeps "Remover definitivamente" disabled until the typed name matches exactly', async () => {
    render(<RemoveGozapChannelDialog channel={CHANNEL} open={true} onOpenChange={() => {}} />);
    const submit = screen.getByRole('button', { name: /Remover definitivamente/i });
    expect(submit).toBeDisabled();

    await userEvent.type(screen.getByLabelText(/Para confirmar, digite o nome do canal/i), 'Loja');
    expect(submit).toBeDisabled();

    await userEvent.type(screen.getByLabelText(/Para confirmar, digite o nome do canal/i), ' 1');
    expect(submit).toBeEnabled();
  });

  it('calls delete with the channel id and shows a success toast once typed name matches and confirmed', async () => {
    mutateAsync.mockResolvedValue(undefined);
    render(<RemoveGozapChannelDialog channel={CHANNEL} open={true} onOpenChange={() => {}} />);

    await userEvent.type(
      screen.getByLabelText(/Para confirmar, digite o nome do canal/i),
      'Loja 1',
    );
    fireEvent.click(screen.getByRole('button', { name: /Remover definitivamente/i }));

    await waitFor(() => expect(mutateAsync).toHaveBeenCalledWith('ch1'));
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('Canal removido'));
  });

  it('shows an error toast and does not close the dialog when removal fails', async () => {
    mutateAsync.mockRejectedValue(new Error('GoZap fora do ar'));
    const onOpenChange = vi.fn();
    render(
      <RemoveGozapChannelDialog channel={CHANNEL} open={true} onOpenChange={onOpenChange} />,
    );

    await userEvent.type(
      screen.getByLabelText(/Para confirmar, digite o nome do canal/i),
      'Loja 1',
    );
    fireEvent.click(screen.getByRole('button', { name: /Remover definitivamente/i }));

    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it('a mistyped name never enables the button — a close typo cannot delete the wrong channel', async () => {
    render(<RemoveGozapChannelDialog channel={CHANNEL} open={true} onOpenChange={() => {}} />);
    await userEvent.type(
      screen.getByLabelText(/Para confirmar, digite o nome do canal/i),
      'Loja 2',
    );
    expect(screen.getByRole('button', { name: /Remover definitivamente/i })).toBeDisabled();
  });

  it('warns that removal is permanent', () => {
    render(<RemoveGozapChannelDialog channel={CHANNEL} open={true} onOpenChange={() => {}} />);
    expect(screen.getByText(/não é possível desfazer/i)).toBeInTheDocument();
  });

  it('renders nothing when there is no channel target', () => {
    const { container } = render(
      <RemoveGozapChannelDialog channel={null} open={false} onOpenChange={() => {}} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
