import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sendText = vi.fn().mockResolvedValue({ id: 'm1' });
const sendMedia = vi.fn();
const typingMutate = vi.fn();
vi.mock('../api', () => ({
  useSendReply: () => ({ mutateAsync: sendText, isPending: false, isError: false }),
  useSendMedia: () => ({ mutateAsync: sendMedia, isPending: false, isError: false }),
  useTyping: () => ({ mutate: typingMutate }),
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

describe('MessageComposer upload hardening (Médio)', () => {
  beforeEach(() => { sendMedia.mockReset(); typingMutate.mockClear(); });

  it('resets the file input value even when the upload is rejected', async () => {
    sendMedia.mockRejectedValueOnce(new Error('413 Payload Too Large'));
    render(<MessageComposer conversationId="c1" reply={null} onClearReply={() => {}} />);
    const input = screen.getByTestId('chat-file-input') as HTMLInputElement;
    const file = new File(['x'], 'big.png', { type: 'image/png' });
    // Spy on the value setter so we can assert it was reset to '' in the finally
    // block even though jsdom won't actually hold a file value.
    const valueSets: string[] = [];
    Object.defineProperty(input, 'value', {
      get: () => valueSets[valueSets.length - 1] ?? '',
      set: (v: string) => { valueSets.push(v); },
      configurable: true,
    });

    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(sendMedia).toHaveBeenCalled());
    // After a rejected upload the input must be cleared so the SAME file can be
    // re-selected (the browser won't fire onChange for an unchanged value).
    await waitFor(() => expect(valueSets).toContain(''));
  });

  it('does not throw an unhandled rejection when the upload fails', async () => {
    sendMedia.mockRejectedValueOnce(new Error('network'));
    const onRejection = vi.fn();
    process.on('unhandledRejection', onRejection);
    render(<MessageComposer conversationId="c1" reply={null} onClearReply={() => {}} />);
    const input = screen.getByTestId('chat-file-input') as HTMLInputElement;
    const file = new File(['x'], 'a.png', { type: 'image/png' });

    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => expect(sendMedia).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));

    expect(onRejection).not.toHaveBeenCalled();
    process.off('unhandledRejection', onRejection);
  });
});

describe('MessageComposer typing paused (Baixo)', () => {
  beforeEach(() => { typingMutate.mockClear(); sendText.mockClear(); });

  it('emits typing "paused" after sending a message', async () => {
    render(<MessageComposer conversationId="c1" reply={null} onClearReply={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText('Escreva uma mensagem…'), { target: { value: 'oi' } });
    fireEvent.click(screen.getByLabelText('Enviar'));
    await waitFor(() => expect(sendText).toHaveBeenCalled());
    expect(typingMutate).toHaveBeenCalledWith('paused');
  });

  it('emits typing "paused" when the textarea loses focus with composing in flight', () => {
    render(<MessageComposer conversationId="c1" reply={null} onClearReply={() => {}} />);
    const ta = screen.getByPlaceholderText('Escreva uma mensagem…');
    fireEvent.change(ta, { target: { value: 'digitando' } });
    typingMutate.mockClear();
    fireEvent.blur(ta);
    expect(typingMutate).toHaveBeenCalledWith('paused');
  });
});
