import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChannelProvider } from '@/features/whatsapp/api';

const sendMutate = vi.fn().mockResolvedValue({ id: 'm1' });
const sendMediaMutate = vi.fn().mockResolvedValue({ id: 'm2' });
const typingMutate = vi.fn();
vi.mock('../api', () => ({
  useSendReply: () => ({ mutateAsync: sendMutate, isPending: false, isError: false }),
  useTyping: () => ({ mutate: typingMutate }),
  useSendMedia: () => ({ mutateAsync: sendMediaMutate, isPending: false, isError: false }),
}));
// message-composer agora lê traits+capabilities do backend via useProviderInfo
// (pré-requisito da F-A), em vez de literais 'EVOLUTION'/'TWILIO'/etc.
// hardcoded — sem mock, o hook real chamaria useQuery e explodiria por falta
// de QueryClient aqui. A fixture importada abaixo é o mapa provider→info REAL
// que o backend expõe hoje para os 4 providers, compartilhado com os demais
// specs do composer (elimina a duplicação que a F0 deixou registrada).
//
// Hoisting: vi.mock é içado para o topo do módulo, então a factory não pode
// referenciar `PROVIDER_INFO` importado estaticamente acima dela — por isso o
// import dinâmico dentro da própria factory.
//
// `HYPOTHETICAL_SESSION_PROVIDER` NÃO é um provider real e não é adicionado a
// lugar nenhum do app (nem CHANNEL_PROVIDERS, nem backend) — é só uma chave
// sintética, local a este spec, para simular o formato do PRÓXIMO provider da
// F-A: `sessionBased: true` (mesma política do EVOLUTION) mas SEM as
// capacidades `inboxChat`/`chatMedia` que só o adapter EVOLUTION implementa.
// É exatamente o buraco que esta tarefa fecha (ver brief da F-A).
vi.mock('@/features/whatsapp/api', async (importOriginal) => {
  const { PROVIDER_INFO } = await import('@/features/whatsapp/__fixtures__/provider-info');
  const TEST_PROVIDER_INFO = {
    ...PROVIDER_INFO,
    HYPOTHETICAL_SESSION_PROVIDER: {
      traits: { official: false, sessionBased: true, sessionWindow: false },
      capabilities: ['campaignSend'],
    },
  };
  return {
    ...(await importOriginal<typeof import('@/features/whatsapp/api')>()),
    useProviderInfo: (provider?: string) =>
      provider ? TEST_PROVIDER_INFO[provider as keyof typeof TEST_PROVIDER_INFO] : undefined,
  };
});
// T7: o estado "janela fechada" (TWILIO sem twilioWindowExpiresAt) renderiza um
// Link do TanStack Router — stub para não exigir RouterProvider aqui.
vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children, ...rest }: { to: string; children: React.ReactNode } & Record<string, unknown>) => (
    <a href={to} {...rest}>{children}</a>
  ),
}));
import { MessageComposer } from './message-composer';

describe('MessageComposer provider gate (non-EVOLUTION channels)', () => {
  beforeEach(() => {
    sendMutate.mockClear();
    sendMediaMutate.mockClear();
    typingMutate.mockClear();
  });

  it('leaves the composer fully enabled for EVOLUTION conversations (unchanged behaviour)', () => {
    render(<MessageComposer conversationId="c1" reply={null} onClearReply={() => {}} provider="EVOLUTION" />);
    expect(screen.getByPlaceholderText('Escreva uma mensagem…')).not.toBeDisabled();
    expect(screen.getByLabelText('Anexar')).not.toBeDisabled();
    expect(screen.getByLabelText('Enviar')).toBeDisabled(); // still gated by empty text, as before
    expect(screen.queryByTestId('provider-not-supported-banner')).toBeNull();
  });

  it('leaves the composer fully enabled when provider is absent (loading/legacy data)', () => {
    render(<MessageComposer conversationId="c1" reply={null} onClearReply={() => {}} />);
    expect(screen.getByPlaceholderText('Escreva uma mensagem…')).not.toBeDisabled();
    expect(screen.getByLabelText('Anexar')).not.toBeDisabled();
    expect(screen.queryByTestId('provider-not-supported-banner')).toBeNull();
  });

  // T7: TWILIO sem twilioWindowExpiresAt = janela de 24h fechada (nenhum
  // inbound registrado) — o composer trava, mas com o aviso da janela, não
  // mais com o banner genérico de provedor.
  it('disables the text field, attach and send buttons for a TWILIO conversation without an open window', () => {
    render(<MessageComposer conversationId="c1" reply={null} onClearReply={() => {}} provider="TWILIO" />);
    expect(screen.getByPlaceholderText('Escreva uma mensagem…')).toBeDisabled();
    expect(screen.getByLabelText('Anexar')).toBeDisabled();
    expect(screen.getByLabelText('Enviar')).toBeDisabled();
  });

  it('shows the 24h-window warning (not the generic provider banner) for a TWILIO conversation', () => {
    render(<MessageComposer conversationId="c1" reply={null} onClearReply={() => {}} provider="TWILIO" />);
    expect(screen.getByTestId('twilio-window-closed-banner')).toHaveTextContent(
      'Janela de 24h fechada — envie um template aprovado para reabrir a conversa.',
    );
    expect(screen.queryByTestId('provider-not-supported-banner')).toBeNull();
  });

  it('does not send on Enter for a TWILIO conversation (composer stays disabled)', () => {
    render(<MessageComposer conversationId="c1" reply={null} onClearReply={() => {}} provider="TWILIO" />);
    const textarea = screen.getByPlaceholderText('Escreva uma mensagem…');
    fireEvent.change(textarea, { target: { value: 'oi' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(sendMutate).not.toHaveBeenCalled();
  });

  it('does not upload a file selected on a TWILIO conversation', async () => {
    render(<MessageComposer conversationId="c1" reply={null} onClearReply={() => {}} provider="TWILIO" />);
    const input = screen.getByTestId('chat-file-input') as HTMLInputElement;
    const file = new File(['x'], 'a.png', { type: 'image/png' });
    fireEvent.change(input, { target: { files: [file] } });
    await new Promise((r) => setTimeout(r, 0));
    expect(sendMediaMutate).not.toHaveBeenCalled();
  });

  it('clicking the disabled attach button does not open the file picker', () => {
    render(<MessageComposer conversationId="c1" reply={null} onClearReply={() => {}} provider="TWILIO" />);
    const clickSpy = vi.spyOn(HTMLInputElement.prototype, 'click');
    fireEvent.click(screen.getByLabelText('Anexar'));
    expect(clickSpy).not.toHaveBeenCalled();
    clickSpy.mockRestore();
  });

  // O BUG: o único canal do cliente é ZERNIO e o composer estava travado com
  // "será liberado em breve" — 16 pessoas que responderam à campanha ficaram
  // sem resposta. O ZERNIO passa a ter o MESMO tratamento do TWILIO: liberado
  // DENTRO da janela de 24h, travado fora dela.
  it('libera o composer numa conversa ZERNIO com a janela de 24h aberta', () => {
    const openWindow = new Date(Date.now() + 6 * 3_600_000).toISOString();
    render(<MessageComposer conversationId="c1" reply={null} onClearReply={() => {}} provider="ZERNIO" twilioWindowExpiresAt={openWindow} />);
    expect(screen.getByPlaceholderText('Escreva uma mensagem…')).not.toBeDisabled();
    expect(screen.queryByTestId('provider-not-supported-banner')).toBeNull();
    expect(screen.getByTestId('twilio-window-badge')).toBeInTheDocument();
  });

  it('envia de fato numa conversa ZERNIO dentro da janela', async () => {
    const openWindow = new Date(Date.now() + 6 * 3_600_000).toISOString();
    render(<MessageComposer conversationId="c1" reply={null} onClearReply={() => {}} provider="ZERNIO" twilioWindowExpiresAt={openWindow} />);
    fireEvent.change(screen.getByPlaceholderText('Escreva uma mensagem…'), { target: { value: 'Obrigado!' } });
    fireEvent.click(screen.getByLabelText('Enviar'));
    await waitFor(() => expect(sendMutate).toHaveBeenCalledWith(expect.objectContaining({ text: 'Obrigado!' })));
  });

  it('ZERNIO sem janela mostra o aviso da JANELA (não mais o banner "em breve")', () => {
    render(<MessageComposer conversationId="c1" reply={null} onClearReply={() => {}} provider="ZERNIO" />);
    expect(screen.getByPlaceholderText('Escreva uma mensagem…')).toBeDisabled();
    expect(screen.getByTestId('twilio-window-closed-banner')).toBeInTheDocument();
    expect(screen.queryByTestId('provider-not-supported-banner')).toBeNull();
  });

  // Mídia outbound segue Evolution-only no backend (chat-media.service lança
  // ChannelNotEvolutionError) — o anexo permanece desabilitado no ZERNIO.
  it('anexo permanece desabilitado no ZERNIO mesmo com a janela aberta', () => {
    const openWindow = new Date(Date.now() + 6 * 3_600_000).toISOString();
    render(<MessageComposer conversationId="c1" reply={null} onClearReply={() => {}} provider="ZERNIO" twilioWindowExpiresAt={openWindow} />);
    expect(screen.getByLabelText('Anexar')).toBeDisabled();
  });

  it('names META in the warning for a META conversation (sem envio implementado)', () => {
    render(<MessageComposer conversationId="c1" reply={null} onClearReply={() => {}} provider="META" />);
    expect(screen.getByTestId('provider-not-supported-banner')).toBeInTheDocument();
  });

  it('typed text is ignored while restricted (onChange no-ops)', () => {
    render(<MessageComposer conversationId="c1" reply={null} onClearReply={() => {}} provider="TWILIO" />);
    const textarea = screen.getByPlaceholderText('Escreva uma mensagem…') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'digitando' } });
    expect(textarea.value).toBe('');
    expect(typingMutate).not.toHaveBeenCalled();
  });

  it('sending still works normally after switching back to an EVOLUTION conversation', async () => {
    const { rerender } = render(<MessageComposer conversationId="c1" reply={null} onClearReply={() => {}} provider="TWILIO" />);
    rerender(<MessageComposer conversationId="c1" reply={null} onClearReply={() => {}} provider="EVOLUTION" />);
    const textarea = screen.getByPlaceholderText('Escreva uma mensagem…');
    fireEvent.change(textarea, { target: { value: 'oi' } });
    fireEvent.click(screen.getByLabelText('Enviar'));
    await waitFor(() => expect(sendMutate).toHaveBeenCalled());
  });
});

// O BUG QUE ESTA TAREFA EXISTE PARA PREVENIR: a F0 converteu o gate de cima
// (`providerRestricted`) para o trait `sessionBased`, mas isso só é seguro
// hoje porque EVOLUTION é o ÚNICO provider `sessionBased: true`. Um provider
// FUTURO com `sessionBased: true` que NÃO seja o adapter Evolution (sem
// `inboxChat`/`chatMedia`) abriria a caixa de texto e o botão de anexo contra
// um backend que lança exceção — 409 na cara do operador. `useProviderInfo`
// dirigido por CAPACIDADE precisa travar esse canal do mesmo jeito que trava
// o META, mesmo com o trait de política dizendo "sessionBased".
describe('MessageComposer gate por capacidade (canal sessionBased que NÃO é Evolution)', () => {
  beforeEach(() => {
    sendMutate.mockClear();
    sendMediaMutate.mockClear();
  });

  it('trava texto e anexo para um provider sessionBased sem inboxChat/chatMedia', () => {
    render(
      <MessageComposer
        conversationId="c1"
        reply={null}
        onClearReply={() => {}}
        provider={'HYPOTHETICAL_SESSION_PROVIDER' as ChannelProvider}
      />,
    );
    expect(screen.getByPlaceholderText('Escreva uma mensagem…')).toBeDisabled();
    expect(screen.getByLabelText('Enviar')).toBeDisabled();
    expect(screen.getByLabelText('Anexar')).toBeDisabled();
  });

  it('não envia no Enter para esse provider mesmo com sessionBased: true', () => {
    render(
      <MessageComposer
        conversationId="c1"
        reply={null}
        onClearReply={() => {}}
        provider={'HYPOTHETICAL_SESSION_PROVIDER' as ChannelProvider}
      />,
    );
    const textarea = screen.getByPlaceholderText('Escreva uma mensagem…');
    fireEvent.change(textarea, { target: { value: 'oi' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(sendMutate).not.toHaveBeenCalled();
  });
});
