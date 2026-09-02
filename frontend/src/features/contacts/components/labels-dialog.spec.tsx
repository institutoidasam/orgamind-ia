import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const saveMutateAsync = vi.fn();
vi.mock('../api', () => ({
  useSetContactLabels: () => ({ mutateAsync: saveMutateAsync, isPending: false }),
}));

const labelsData = vi.fn();
const labelsLoading = vi.fn();
const labelsError = vi.fn();
vi.mock('@/features/whatsapp/api', () => ({
  useWhatsappLabels: () => ({
    data: labelsData(),
    isLoading: labelsLoading(),
    isError: labelsError(),
  }),
}));

const toastError = vi.fn();
const toastSuccess = vi.fn();
vi.mock('sonner', () => ({
  toast: {
    error: (...a: unknown[]) => toastError(...a),
    success: (...a: unknown[]) => toastSuccess(...a),
  },
}));

const invalidateQueries = vi.fn();
vi.mock('@tanstack/react-query', async () => {
  const actual =
    await vi.importActual<typeof import('@tanstack/react-query')>(
      '@tanstack/react-query',
    );
  return { ...actual, useQueryClient: () => ({ invalidateQueries }) };
});

import { LabelsDialog } from './labels-dialog';
import type { Contact } from '../schemas';

const contact = {
  id: 'c1',
  phoneE164: '+5592999',
  name: 'Maria',
  waLabels: [],
} as unknown as Contact;

beforeEach(() => {
  saveMutateAsync.mockReset();
  toastError.mockReset();
  toastSuccess.mockReset();
  invalidateQueries.mockReset();
  labelsLoading.mockReset();
  labelsError.mockReset();
  labelsLoading.mockReturnValue(false);
  labelsError.mockReturnValue(false);
  labelsData.mockReturnValue([
    { id: 'l1', name: 'VIP', color: '00ff00' },
    { id: 'l2', name: 'Lead', color: 'ff0000' },
  ]);
});

describe('LabelsDialog — partial failure handling', () => {
  it('invalidates the contacts cache even when the save throws (partial apply)', async () => {
    saveMutateAsync.mockRejectedValue(new Error('partial'));
    render(<LabelsDialog open onOpenChange={() => {}} contact={contact} />);

    fireEvent.click(screen.getByText('VIP'));
    fireEvent.click(screen.getByRole('button', { name: /salvar/i }));

    // Backend may have persisted some of the diff before throwing, so the
    // local cache must be refreshed regardless of success/failure.
    await waitFor(() => expect(invalidateQueries).toHaveBeenCalled());
  });

  it('shows a "parcialmente aplicadas" message on failure', async () => {
    saveMutateAsync.mockRejectedValue(new Error('partial'));
    render(<LabelsDialog open onOpenChange={() => {}} contact={contact} />);

    fireEvent.click(screen.getByText('VIP'));
    fireEvent.click(screen.getByRole('button', { name: /salvar/i }));

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        expect.stringMatching(/parcialmente/i),
      ),
    );
  });

  it('still invalidates and shows success on a clean save', async () => {
    saveMutateAsync.mockResolvedValue({ id: 'c1' });
    const onOpenChange = vi.fn();
    render(<LabelsDialog open onOpenChange={onOpenChange} contact={contact} />);

    fireEvent.click(screen.getByText('VIP'));
    fireEvent.click(screen.getByRole('button', { name: /salvar/i }));

    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    expect(invalidateQueries).toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe('LabelsDialog — body states', () => {
  it('renders the loading state while labels are loading', () => {
    labelsLoading.mockReturnValue(true);
    labelsData.mockReturnValue(undefined);
    render(<LabelsDialog open onOpenChange={() => {}} contact={contact} />);

    expect(screen.getByText(/carregando/i)).toBeInTheDocument();
    // No list and no empty/error message in the loading state.
    expect(screen.queryByText('VIP')).not.toBeInTheDocument();
    // Save is disabled while loading.
    expect(screen.getByRole('button', { name: /salvar/i })).toBeDisabled();
  });

  it('renders the error state when the labels query fails', () => {
    labelsError.mockReturnValue(true);
    labelsData.mockReturnValue(undefined);
    render(<LabelsDialog open onOpenChange={() => {}} contact={contact} />);

    expect(
      screen.getByText(/não foi possível carregar as etiquetas/i),
    ).toBeInTheDocument();
    expect(screen.queryByText('VIP')).not.toBeInTheDocument();
  });

  it('renders the empty state when the account has no labels', () => {
    labelsData.mockReturnValue([]);
    render(<LabelsDialog open onOpenChange={() => {}} contact={contact} />);

    expect(
      screen.getByText(/nenhuma etiqueta configurada/i),
    ).toBeInTheDocument();
    expect(screen.queryByText('VIP')).not.toBeInTheDocument();
  });

  it('renders the label list with names and colors', () => {
    render(<LabelsDialog open onOpenChange={() => {}} contact={contact} />);

    expect(screen.getByText('VIP')).toBeInTheDocument();
    expect(screen.getByText('Lead')).toBeInTheDocument();
    expect(screen.getByText('#00ff00')).toBeInTheDocument();
    expect(screen.getByText('#ff0000')).toBeInTheDocument();
  });
});

describe('LabelsDialog — toggle + save flow', () => {
  it('pre-checks labels already applied to the contact', () => {
    const withLabel = { ...contact, waLabels: ['l1'] } as unknown as Contact;
    render(<LabelsDialog open onOpenChange={() => {}} contact={withLabel} />);

    const boxes = screen.getAllByRole('checkbox');
    // l1 (VIP) starts checked, l2 (Lead) starts unchecked.
    expect(boxes[0]).toBeChecked();
    expect(boxes[1]).not.toBeChecked();
  });

  it('saves the toggled selection as labelIds', async () => {
    saveMutateAsync.mockResolvedValue({ id: 'c1' });
    render(<LabelsDialog open onOpenChange={() => {}} contact={contact} />);

    fireEvent.click(screen.getByText('VIP'));
    fireEvent.click(screen.getByText('Lead'));
    fireEvent.click(screen.getByRole('button', { name: /salvar/i }));

    await waitFor(() => expect(saveMutateAsync).toHaveBeenCalled());
    expect(saveMutateAsync).toHaveBeenCalledWith({
      id: 'c1',
      labelIds: ['l1', 'l2'],
    });
  });

  it('removes a label from the selection when unchecked', async () => {
    saveMutateAsync.mockResolvedValue({ id: 'c1' });
    const withLabel = { ...contact, waLabels: ['l1'] } as unknown as Contact;
    render(<LabelsDialog open onOpenChange={() => {}} contact={withLabel} />);

    // Uncheck the pre-checked VIP label.
    fireEvent.click(screen.getByText('VIP'));
    fireEvent.click(screen.getByRole('button', { name: /salvar/i }));

    await waitFor(() => expect(saveMutateAsync).toHaveBeenCalled());
    expect(saveMutateAsync).toHaveBeenCalledWith({ id: 'c1', labelIds: [] });
  });
});
