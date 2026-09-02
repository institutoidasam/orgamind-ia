import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
// referenciar um import estático feito acima dela — por isso o import
// dinâmico dentro da própria factory.
vi.mock('@/features/whatsapp/api', async (importOriginal) => {
  const { PROVIDER_INFO } = await import('@/features/whatsapp/__fixtures__/provider-info');
  return {
    ...(await importOriginal<typeof import('@/features/whatsapp/api')>()),
    useProviderInfo: (provider?: string) =>
      provider ? PROVIDER_INFO[provider as keyof typeof PROVIDER_INFO] : undefined,
  };
});
// O CTA "Enviar template" navega para o fluxo de campanha via Link do
// TanStack Router — stub para não exigir um RouterProvider no teste.
vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children, ...rest }: { to: string; children: React.ReactNode } & Record<string, unknown>) => (
    <a href={to} {...rest}>{children}</a>
  ),
}));

import { MessageComposer, formatWindowRemaining } from './message-composer';

const NOW = new Date('2026-07-10T12:00:00Z');
const iso = (offsetMs: number) => new Date(NOW.getTime() + offsetMs).toISOString();
const H = 3_600_000;
const MIN = 60_000;

// A janela de 24h é regra da META, não da Twilio: vale IDENTICAMENTE para
// TWILIO e para ZERNIO (os dois falam com a Cloud API). Mesmo padrão, mesmo
// teste — nada de atalho para o Zernio.
describe.each(['TWILIO', 'ZERNIO'] as const)(
  'MessageComposer janela de 24h (canal %s)',
  (provider: ChannelProvider) => {
    beforeEach(() => {
      sendMutate.mockClear();
      sendMediaMutate.mockClear();
      typingMutate.mockClear();
      vi.useFakeTimers({ shouldAdvanceTime: false });
      vi.setSystemTime(NOW);
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    function renderComposer(twilioWindowExpiresAt: string | null) {
      return render(
        <MessageComposer
          conversationId="c1"
          reply={null}
          onClearReply={() => {}}
          provider={provider}
          twilioWindowExpiresAt={twilioWindowExpiresAt}
        />,
      );
    }

    describe('janela aberta', () => {
      it('mostra o badge "Janela fecha em Xh Ymin" e mantém o texto habilitado', () => {
        renderComposer(iso(5 * H + 32 * MIN));
        expect(screen.getByTestId('twilio-window-badge')).toHaveTextContent('Janela fecha em 5h 32min');
        expect(screen.getByPlaceholderText('Escreva uma mensagem…')).not.toBeDisabled();
        expect(screen.queryByTestId('twilio-window-closed-banner')).toBeNull();
        expect(screen.queryByTestId('provider-not-supported-banner')).toBeNull();
      });

      it('envia texto normalmente com a janela aberta', async () => {
        renderComposer(iso(2 * H));
        const textarea = screen.getByPlaceholderText('Escreva uma mensagem…');
        fireEvent.change(textarea, { target: { value: 'oi' } });
        fireEvent.click(screen.getByLabelText('Enviar'));
        // Fake timers ativos: waitFor não avança — basta esvaziar a microtask
        // queue (o mutateAsync mockado resolve imediatamente).
        await act(async () => { await Promise.resolve(); });
        expect(sendMutate).toHaveBeenCalledWith(expect.objectContaining({ text: 'oi' }));
      });

      it('atualiza o countdown a cada minuto', () => {
        renderComposer(iso(2 * H + 10 * MIN));
        expect(screen.getByTestId('twilio-window-badge')).toHaveTextContent('2h 10min');
        act(() => { vi.advanceTimersByTime(MIN); });
        expect(screen.getByTestId('twilio-window-badge')).toHaveTextContent('2h 9min');
      });

      it('trava o composer sozinho quando o countdown cruza o zero', () => {
        renderComposer(iso(90_000)); // fecha em 90s
        expect(screen.getByTestId('twilio-window-badge')).toBeInTheDocument();
        act(() => { vi.advanceTimersByTime(2 * MIN); });
        expect(screen.queryByTestId('twilio-window-badge')).toBeNull();
        expect(screen.getByTestId('twilio-window-closed-banner')).toBeInTheDocument();
        expect(screen.getByPlaceholderText('Escreva uma mensagem…')).toBeDisabled();
      });

      it('anexo continua desabilitado mesmo com a janela aberta (mídia outbound é Evolution-only)', () => {
        renderComposer(iso(2 * H));
        expect(screen.getByLabelText('Anexar')).toBeDisabled();
        const input = screen.getByTestId('chat-file-input') as HTMLInputElement;
        fireEvent.change(input, { target: { files: [new File(['x'], 'a.png', { type: 'image/png' })] } });
        expect(sendMediaMutate).not.toHaveBeenCalled();
      });
    });

    describe('janela fechada (expirada ou null)', () => {
      it.each([
        ['expirada', iso(-1 * H)],
        ['null (nenhum inbound registrado)', null],
      ])('desabilita o composer e mostra o aviso — janela %s', (_label, expiresAt) => {
        renderComposer(expiresAt);
        expect(screen.getByPlaceholderText('Escreva uma mensagem…')).toBeDisabled();
        expect(screen.getByLabelText('Enviar')).toBeDisabled();
        expect(screen.getByLabelText('Anexar')).toBeDisabled();
        expect(screen.getByTestId('twilio-window-closed-banner')).toHaveTextContent(
          'Janela de 24h fechada — envie um template aprovado para reabrir a conversa.',
        );
        expect(screen.queryByTestId('twilio-window-badge')).toBeNull();
        // Nunca o banner "em breve": o canal SUPORTA responder; o que impede é
        // a janela — e o operador precisa enxergar a diferença.
        expect(screen.queryByTestId('provider-not-supported-banner')).toBeNull();
      });

      it('oferece o CTA "Enviar template" apontando para o fluxo de campanha', () => {
        renderComposer(null);
        const cta = screen.getByRole('link', { name: 'Enviar template' });
        expect(cta).toHaveAttribute('href', '/campaigns/new');
      });

      it('não envia no Enter nem emite typing com a janela fechada', () => {
        renderComposer(iso(-5 * MIN));
        const textarea = screen.getByPlaceholderText('Escreva uma mensagem…') as HTMLTextAreaElement;
        fireEvent.change(textarea, { target: { value: 'oi' } });
        fireEvent.keyDown(textarea, { key: 'Enter' });
        expect(textarea.value).toBe('');
        expect(sendMutate).not.toHaveBeenCalled();
        expect(typingMutate).not.toHaveBeenCalled();
      });
    });
  },
);

describe('canais sem janela de sessão', () => {
  it('EVOLUTION nunca é desabilitado pela janela (null)', () => {
    render(<MessageComposer conversationId="c1" reply={null} onClearReply={() => {}} provider="EVOLUTION" twilioWindowExpiresAt={null} />);
    expect(screen.getByPlaceholderText('Escreva uma mensagem…')).not.toBeDisabled();
    expect(screen.queryByTestId('twilio-window-closed-banner')).toBeNull();
    expect(screen.queryByTestId('twilio-window-badge')).toBeNull();
  });

  it('EVOLUTION nunca é desabilitado pela janela (expirada)', () => {
    render(<MessageComposer conversationId="c1" reply={null} onClearReply={() => {}} provider="EVOLUTION" twilioWindowExpiresAt={iso(-1 * H)} />);
    expect(screen.getByPlaceholderText('Escreva uma mensagem…')).not.toBeDisabled();
    expect(screen.queryByTestId('twilio-window-closed-banner')).toBeNull();
  });

  it('META segue com o banner "em breve" (não há caminho de envio implementado)', () => {
    render(<MessageComposer conversationId="c1" reply={null} onClearReply={() => {}} provider="META" twilioWindowExpiresAt={null} />);
    expect(screen.getByTestId('provider-not-supported-banner')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Escreva uma mensagem…')).toBeDisabled();
    expect(screen.queryByTestId('twilio-window-closed-banner')).toBeNull();
  });
});

describe('formatWindowRemaining', () => {
  it('formata horas e minutos', () => {
    expect(formatWindowRemaining(5 * H + 32 * MIN)).toBe('5h 32min');
    expect(formatWindowRemaining(1 * H)).toBe('1h 0min');
  });
  it('abaixo de 1h mostra só minutos', () => {
    expect(formatWindowRemaining(45 * MIN)).toBe('45min');
  });
  it('nunca mostra "0min" — abaixo de um minuto arredonda para 1min', () => {
    expect(formatWindowRemaining(20_000)).toBe('1min');
  });
});
