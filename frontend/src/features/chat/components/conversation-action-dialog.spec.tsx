import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { ConversationActionDialog } from './conversation-action-dialog';

function renderDialog() {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(<ConversationActionDialog open title="Resolver conversa" onConfirm={onConfirm} onCancel={onCancel} />);
  return { onConfirm, onCancel };
}

describe('ConversationActionDialog — observação', () => {
  it('observação limitada a 200; vazia não é enviada', () => {
    const { onConfirm } = renderDialog();
    expect(screen.getByRole('dialog', { name: 'Resolver conversa' })).toBeInTheDocument();
    const field = screen.getByLabelText('Observação (opcional)');
    expect(field).toHaveAttribute('maxlength', '200');

    fireEvent.change(field, { target: { value: 'x'.repeat(250) } });
    expect((field as HTMLTextAreaElement).value).toHaveLength(200);

    fireEvent.change(field, { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar' }));
    expect(onConfirm).toHaveBeenCalledWith(undefined);
  });

  it('observação preenchida segue sem espaços nas pontas', () => {
    const { onConfirm } = renderDialog();
    fireEvent.change(screen.getByLabelText('Observação (opcional)'), { target: { value: '  passei o caso  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar' }));
    expect(onConfirm).toHaveBeenCalledWith('passei o caso');
  });
});

describe('ConversationActionDialog — cancelar', () => {
  it('Cancelar fecha sem chamar', () => {
    const { onConfirm, onCancel } = renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
