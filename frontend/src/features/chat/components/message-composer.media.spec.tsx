import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sendText = vi.fn().mockResolvedValue({ id: 'm1' });
const sendMedia = vi.fn().mockResolvedValue({ id: 'm2' });
vi.mock('../api', () => ({
  useSendReply: () => ({ mutateAsync: sendText, isPending: false, isError: false }),
  useSendMedia: () => ({ mutateAsync: sendMedia, isPending: false }),
  useTyping: () => ({ mutate: vi.fn() }),
}));
// message-composer agora lê traits+capabilities do backend via useProviderInfo
// (pré-requisito da F-A); sem mock, o hook real chamaria useQuery e explodiria
// por falta de QueryClient aqui. Este teste não passa `provider`, então
// undefined basta.
vi.mock('@/features/whatsapp/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/whatsapp/api')>()),
  useProviderInfo: () => undefined,
}));
import { MessageComposer } from './message-composer';

describe('MessageComposer media', () => {
  beforeEach(() => { sendMedia.mockClear(); });
  it('uploads a selected file', async () => {
    render(<MessageComposer conversationId="c1" reply={null} onClearReply={() => {}} />);
    const input = screen.getByTestId('chat-file-input') as HTMLInputElement;
    const file = new File(['x'], 'a.png', { type: 'image/png' });
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => expect(sendMedia).toHaveBeenCalledWith(expect.objectContaining({ file })));
  });
});
