import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HTTPError } from 'ky';
import { describe, expect, it, vi } from 'vitest';
import { PersonStatusDialog } from './person-status-dialog';

function setup(isActive: boolean, onConfirm = vi.fn().mockResolvedValue(undefined)) {
  const onOpenChange = vi.fn();
  render(<PersonStatusDialog person={{ name: 'Rita', isActive }} open onOpenChange={onOpenChange} onConfirm={onConfirm} />);
  return { onConfirm, onOpenChange, ui: userEvent.setup() };
}

describe('PersonStatusDialog', () => {
  it('o título nomeia a pessoa e a ação: Inativar ou Reativar', () => {
    setup(true);
    expect(screen.getByRole('heading', { name: 'Inativar Rita?' })).toBeInTheDocument();
  });

  it('pessoa inativa pergunta "Reativar <nome>?"', () => {
    setup(false);
    expect(screen.getByRole('heading', { name: 'Reativar Rita?' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reativar' })).toBeInTheDocument();
  });

  it('confirmar sem motivo mostra o erro e não chama onConfirm', async () => {
    const { onConfirm, ui } = setup(true);
    await ui.click(screen.getByRole('button', { name: 'Inativar' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Informe o motivo, de 3 a 200 caracteres');
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('com motivo chama onConfirm com o texto aparado e fecha o diálogo', async () => {
    const { onConfirm, onOpenChange, ui } = setup(true);
    await ui.type(screen.getByLabelText('Motivo da alteração'), '  Saiu da empresa ');
    await ui.click(screen.getByRole('button', { name: 'Inativar' }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith('Saiu da empresa'));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it('erro da API aparece no diálogo com o texto do servidor e o diálogo continua aberto', async () => {
    const detail = 'Você não pode inativar ou reativar esta pessoa. Pessoa com acesso ao sistema, só o administrador.';
    const response = new Response(JSON.stringify({ code: 'sector_people.status_forbidden', detail }), { status: 403 });
    const onConfirm = vi.fn().mockRejectedValue(new HTTPError(response, new Request('https://x'), {} as never));
    const { onOpenChange, ui } = setup(true, onConfirm);
    await ui.type(screen.getByLabelText('Motivo da alteração'), 'Saiu da empresa');
    await ui.click(screen.getByRole('button', { name: 'Inativar' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(detail);
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});
