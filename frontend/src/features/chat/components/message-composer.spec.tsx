import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HTTPError } from 'ky';

const sendMutate = vi.fn().mockResolvedValue({ id: 'm1' });
const sendMediaMutate = vi.fn().mockResolvedValue({ id: 'm2' });
vi.mock('../api', () => ({
  useSendReply: () => ({ mutateAsync: sendMutate, isPending: false, isError: false }),
  useTyping: () => ({ mutate: vi.fn() }),
  useSendMedia: () => ({ mutateAsync: sendMediaMutate, isPending: false }),
}));
// message-composer agora lê traits+capabilities do backend via useProviderInfo
// (pré-requisito da F-A); sem mock, o hook real chamaria useQuery e explodiria
// por falta de QueryClient aqui. Só o EVOLUTION tem info (é o único provedor
// ligado e, portanto, o único que /whatsapp/providers devolve); os desligados
// ficam sem info, como em produção.
vi.mock('@/features/whatsapp/api', async (importOriginal) => {
  const { PROVIDER_INFO } = await import('@/features/whatsapp/__fixtures__/provider-info');
  return {
    ...(await importOriginal<typeof import('@/features/whatsapp/api')>()),
    useProviderInfo: (provider?: string) => (provider === 'EVOLUTION' ? PROVIDER_INFO.EVOLUTION : undefined),
  };
});
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

const DISABLED_TITLE = 'Este número usa uma integração desligada (GoZap).';

/** Erro 409 channel.provider_disabled como o ky entrega (corpo em `data`). */
async function providerDisabledError(url: string) {
  const body = { code: 'channel.provider_disabled', status: 409, title: DISABLED_TITLE, detail: 'provider=GOZAP' };
  const res = new Response(JSON.stringify(body), { status: 409 });
  await res.text();
  const err = new HTTPError(res, new Request(url), {} as never);
  err.data = body as HTTPError['data'];
  return err;
}

// R11 / cenário 12: conversa de canal desligado fica legível, mas o composer
// trava com o aviso exato de GC11 (e não fica em "Carregando…" para sempre,
// porque o provedor desligado não vem de /whatsapp/providers).
describe('MessageComposer canal de integração desligada', () => {
  beforeEach(() => sendMutate.mockClear());

  it.each([
    ['GOZAP', 'GoZap'],
    ['ZERNIO', 'Zernio'],
    ['TWILIO', 'Twilio'],
    ['META', 'Meta'],
  ] as const)('%s: aviso exato e envio desabilitado', (provider, label) => {
    render(<MessageComposer conversationId="c1" reply={null} onClearReply={() => {}} provider={provider} />);
    expect(screen.getByTestId('provider-disabled-banner')).toHaveTextContent(
      `Este número usa uma integração desligada (${label}). Para responder, conecte um número Evolution em Conexões.`,
    );
    expect(screen.queryByTestId('provider-traits-loading')).toBeNull();
    expect(screen.getByPlaceholderText('Escreva uma mensagem…')).toBeDisabled();
    expect(screen.getByLabelText('Anexar')).toBeDisabled();
    expect(screen.getByLabelText('Enviar')).toBeDisabled();
  });

  it('EVOLUTION: envio liberado', () => {
    render(<MessageComposer conversationId="c1" reply={null} onClearReply={() => {}} provider="EVOLUTION" />);
    expect(screen.queryByTestId('provider-disabled-banner')).toBeNull();
    const textarea = screen.getByPlaceholderText('Escreva uma mensagem…');
    expect(textarea).not.toBeDisabled();
    expect(screen.getByLabelText('Anexar')).not.toBeDisabled();
    fireEvent.change(textarea, { target: { value: 'oi' } });
    expect(screen.getByLabelText('Enviar')).not.toBeDisabled();
  });

  it('aviso de canal desligado é a descrição acessível da caixa de texto', () => {
    const notice = 'Este número usa uma integração desligada (GoZap). Para responder, conecte um número Evolution em Conexões.';
    render(<MessageComposer conversationId="c1" reply={null} onClearReply={() => {}} provider="GOZAP" />);
    const banner = screen.getByTestId('provider-disabled-banner');
    const textbox = screen.getByPlaceholderText('Escreva uma mensagem…');
    expect(textbox).toHaveAccessibleDescription(notice);
    expect(textbox).toHaveAttribute('aria-describedby', banner.id);
  });
});

describe('MessageComposer erro 409 de canal desligado', () => {
  beforeEach(() => sendMutate.mockClear());

  it('409 channel.provider_disabled: mostra o title pt-BR do corpo e mantém o texto digitado', async () => {
    sendMutate.mockRejectedValueOnce(await providerDisabledError('https://api/chat/conversations/c1/messages'));

    render(<MessageComposer conversationId="c1" reply={null} onClearReply={() => {}} provider="EVOLUTION" />);
    const textarea = screen.getByPlaceholderText('Escreva uma mensagem…') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'resposta' } });
    fireEvent.click(screen.getByLabelText('Enviar'));
    const alert = await screen.findByTestId('provider-disabled-send-error');
    expect(alert).toHaveTextContent(DISABLED_TITLE);
    expect(alert).not.toHaveTextContent('provider=GOZAP');
    expect(textarea.value).toBe('resposta');
  });

  it('409 channel.provider_disabled no envio de anexo mostra o title pt-BR, nunca o detail', async () => {
    sendMediaMutate.mockRejectedValueOnce(await providerDisabledError('https://api/chat/conversations/c1/media'));

    const { container } = render(<MessageComposer conversationId="c1" reply={null} onClearReply={() => {}} provider="EVOLUTION" />);
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(fileInput, { target: { files: [new File(['x'], 'foto.png', { type: 'image/png' })] } });
    const alert = await screen.findByTestId('provider-disabled-send-error');
    expect(alert).toHaveTextContent(DISABLED_TITLE);
    expect(alert).not.toHaveTextContent('provider=GOZAP');
  });
});
