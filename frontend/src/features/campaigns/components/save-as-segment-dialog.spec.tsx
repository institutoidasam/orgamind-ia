import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FilterGroup } from '../schemas';

// --- Mocks -----------------------------------------------------------------
const createMutateAsync = vi.fn();
const createPending = vi.fn();
vi.mock('@/features/segments/api', () => ({
  useCreateSegment: () => ({
    mutateAsync: createMutateAsync,
    isPending: createPending(),
  }),
}));

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock('sonner', () => ({
  toast: {
    success: (...a: unknown[]) => toastSuccess(...a),
    error: (...a: unknown[]) => toastError(...a),
  },
}));

import { SaveAsSegmentDialog } from './save-as-segment-dialog';

const FILTERS: FilterGroup = {
  combinator: 'and',
  rules: [{ field: 'city', op: 'eq', value: 'Manaus' }],
};

beforeEach(() => {
  createMutateAsync.mockReset();
  createPending.mockReset();
  toastSuccess.mockReset();
  toastError.mockReset();
  createPending.mockReturnValue(false);
  createMutateAsync.mockResolvedValue({ id: 's1', name: 'Vips' });
});

describe('SaveAsSegmentDialog', () => {
  it('submits the name + current filters, omitting an empty description', async () => {
    const onOpenChange = vi.fn();
    const onSaved = vi.fn();
    render(
      <SaveAsSegmentDialog
        open
        onOpenChange={onOpenChange}
        filters={FILTERS}
        onSaved={onSaved}
      />,
    );

    fireEvent.change(screen.getByLabelText(/Nome/i), {
      target: { value: 'Vips' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Salvar$/i }));

    await waitFor(() => expect(createMutateAsync).toHaveBeenCalled());
    // description must be `undefined` (omitted) when the box is empty — the
    // segment-editor rule for brand-new segments.
    expect(createMutateAsync).toHaveBeenCalledWith({
      name: 'Vips',
      description: undefined,
      filters: FILTERS,
    });
    expect(toastSuccess).toHaveBeenCalled();
    expect(onSaved).toHaveBeenCalledWith({ id: 's1', name: 'Vips' });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('sends the trimmed description when one is provided', async () => {
    render(
      <SaveAsSegmentDialog open onOpenChange={() => {}} filters={FILTERS} />,
    );

    fireEvent.change(screen.getByLabelText(/Nome/i), {
      target: { value: 'Vips' },
    });
    fireEvent.change(screen.getByLabelText(/Descrição/i), {
      target: { value: '  clientes premium  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Salvar$/i }));

    await waitFor(() => expect(createMutateAsync).toHaveBeenCalled());
    expect(createMutateAsync).toHaveBeenCalledWith({
      name: 'Vips',
      description: 'clientes premium',
      filters: FILTERS,
    });
  });

  it('disables "Salvar" until a name is entered', () => {
    render(
      <SaveAsSegmentDialog open onOpenChange={() => {}} filters={FILTERS} />,
    );
    expect(screen.getByRole('button', { name: /^Salvar$/i })).toBeDisabled();
  });

  it('shows an error toast and keeps the dialog open when the save fails', async () => {
    createMutateAsync.mockRejectedValue(new Error('boom'));
    const onOpenChange = vi.fn();
    render(
      <SaveAsSegmentDialog
        open
        onOpenChange={onOpenChange}
        filters={FILTERS}
      />,
    );

    fireEvent.change(screen.getByLabelText(/Nome/i), {
      target: { value: 'Vips' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Salvar$/i }));

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it('calls onOpenChange(false) when "Cancelar" is clicked', () => {
    const onOpenChange = vi.fn();
    render(
      <SaveAsSegmentDialog
        open
        onOpenChange={onOpenChange}
        filters={FILTERS}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Cancelar/i }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
