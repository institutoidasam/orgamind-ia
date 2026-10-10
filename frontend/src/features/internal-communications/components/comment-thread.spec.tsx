import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommunicationDetail } from '../schemas';

const mutation = {
  mutate: vi.fn(),
  isPending: false,
  isError: false,
};

vi.mock('../api', () => ({ useComment: () => mutation }));

import { CommentThread } from './comment-thread';

const events: CommunicationDetail['events'] = [{
  id: 'event-1',
  kind: 'COMMENTED',
  message: 'Comentário persistido',
  author: { id: 'u1', name: 'Bia', email: null },
  createdAt: '2026-10-10T10:00:00.000Z',
}];

describe('CommentThread', () => {
  beforeEach(() => {
    mutation.mutate.mockReset();
    mutation.isPending = false;
    mutation.isError = false;
  });

  it('envia mensagem sem espaços externos e limpa somente após sucesso', async () => {
    const user = userEvent.setup();
    render(<CommentThread communicationId="c1" events={[]} readonly={false} />);

    await user.type(screen.getByLabelText('Adicionar comentário'), '  Atualização  ');
    await user.click(screen.getByRole('button', { name: 'Publicar comentário' }));

    expect(mutation.mutate).toHaveBeenCalledWith('Atualização', expect.any(Object));
    expect(screen.getByLabelText('Adicionar comentário')).not.toHaveValue('');
    const callbacks = mutation.mutate.mock.calls[0][1] as { onSuccess: () => void };
    act(() => callbacks.onSuccess());
    expect(screen.getByLabelText('Adicionar comentário')).toHaveValue('');
  });

  it('desabilita o envio pendente, mostra erro e atualiza o histórico recebido', () => {
    mutation.isPending = true;
    mutation.isError = true;
    const { rerender } = render(<CommentThread communicationId="c1" events={[]} readonly={false} />);

    expect(screen.getByRole('button', { name: 'Publicando comentário…' })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('Não foi possível publicar o comentário');
    mutation.isPending = false;
    mutation.isError = false;
    rerender(<CommentThread communicationId="c1" events={events} readonly={false} />);
    expect(screen.getByText('Comentário persistido')).toBeInTheDocument();
    expect(screen.getByText('Bia')).toBeInTheDocument();
  });

  it('mantém o histórico visível e oculta o composer para leitura', () => {
    render(<CommentThread communicationId="c1" events={events} readonly />);
    expect(screen.getByText('Histórico')).toBeInTheDocument();
    expect(screen.queryByLabelText('Adicionar comentário')).not.toBeInTheDocument();
    expect(mutation.mutate).not.toHaveBeenCalled();
  });
});
