import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sendMutate = vi.fn().mockResolvedValue({ id: 'm1' });
vi.mock('../api', () => ({
  useSendReply: () => ({ mutateAsync: sendMutate, isPending: false, isError: false }),
  useTyping: () => ({ mutate: vi.fn() }),
  useSendMedia: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
// message-composer agora lê traits+capabilities do backend via useProviderInfo
// (pré-requisito da F-A); sem mock, o hook real chamaria useQuery e explodiria
// por falta de QueryClient aqui. Nenhum destes testes passa `provider`, então
// undefined basta.
vi.mock('@/features/whatsapp/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/whatsapp/api')>()),
  useProviderInfo: () => undefined,
}));
import { MessageComposer } from './message-composer';

describe('MessageComposer', () => {
  beforeEach(() => sendMutate.mockClear());

  it('sends the typed text and clears reply', async () => {
    const onClear = vi.fn();
    render(<MessageComposer conversationId="c1" reply={{ waMessageId: 'O1', preview: 'oi' }} onClearReply={onClear} />);
    fireEvent.change(screen.getByPlaceholderText('Escreva uma mensagem…'), { target: { value: 'resposta' } });
    fireEvent.click(screen.getByLabelText('Enviar'));
    await waitFor(() => expect(sendMutate).toHaveBeenCalledWith({ text: 'resposta', quotedWaMessageId: 'O1', quotedPreview: 'oi' }));
    expect(onClear).toHaveBeenCalled();
  });

  it('does not send empty/whitespace text', () => {
    render(<MessageComposer conversationId="c1" reply={null} onClearReply={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText('Escreva uma mensagem…'), { target: { value: '   ' } });
    fireEvent.click(screen.getByLabelText('Enviar'));
    expect(sendMutate).not.toHaveBeenCalled();
  });
});
