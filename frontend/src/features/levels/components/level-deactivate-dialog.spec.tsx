import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { LevelDeactivateDialog } from './level-deactivate-dialog';

const QUESTION = 'Desativar o nível Líder? Ele sai do cadastro novo e do filtro de envio.';

function setup(pending = false) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(<LevelDeactivateDialog open name="Líder" pending={pending} onConfirm={onConfirm} onCancel={onCancel} />);
  return { onConfirm, onCancel };
}

describe('LevelDeactivateDialog', () => {
  it('pergunta com o nome do nível; Desativar confirma e Cancelar não', async () => {
    const { onConfirm, onCancel } = setup();
    expect(screen.getByText(QUESTION)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Desativar' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('gravando, os dois botões ficam desligados', () => {
    setup(true);
    expect((screen.getByRole('button', { name: 'Desativar' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Cancelar' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
