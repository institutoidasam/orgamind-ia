import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HTTPError } from 'ky';
import { describe, expect, it, vi } from 'vitest';
import { PersonStatusDialog } from './person-status-dialog';

/** Caminho comum da ficha e da tela de pessoas do setor: o back manda só o `code` no 409. */
describe('PersonStatusDialog: reativação recusada (E10)', () => {
  it.each([
    ['user.sector_inactive', 'O setor desta pessoa está inativo. Reative o setor ou troque o setor antes de reativar a pessoa.'],
    ['user.level_inactive', 'O nível desta pessoa está desativado. Reative o nível ou troque o nível antes de reativar a pessoa.'],
  ])('aceite 18: 409 %s mostra o texto da spec no diálogo, que continua aberto', async (code, message) => {
    const response = new Response(JSON.stringify({ code }), { status: 409 });
    const onConfirm = vi.fn().mockRejectedValue(new HTTPError(response, new Request('https://x'), {} as never));
    const onOpenChange = vi.fn();
    const ui = userEvent.setup();
    render(<PersonStatusDialog person={{ name: 'Rita', isActive: false }} open onOpenChange={onOpenChange} onConfirm={onConfirm} />);
    await ui.type(screen.getByLabelText('Motivo da alteração'), 'Voltou da licença');
    await ui.click(screen.getByRole('button', { name: 'Reativar' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});
