import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sendMutate = vi.fn().mockResolvedValue({ id: 'm1' });
const sendMediaMutate = vi.fn().mockResolvedValue({ id: 'm2' });
const typingMutate = vi.fn();
vi.mock('../api', () => ({
  useSendReply: () => ({ mutateAsync: sendMutate, isPending: false, isError: false }),
  useTyping: () => ({ mutate: typingMutate }),
  useSendMedia: () => ({ mutateAsync: sendMediaMutate, isPending: false, isError: false }),
}));

// O ESTADO SEM COBERTURA até aqui: `provider` DEFINIDO e `info === undefined`.
// Os specs provider-gate/window mockam um lookup que sempre acha os 4 providers,
// e o teste "provider is absent" passa provider={undefined} — outro ramo. Este
// arquivo mocka o hook devolvendo SEMPRE undefined: é o que acontece de verdade
// quando GET /whatsapp/providers está em voo — ou FALHOU (useProviders usa
// staleTime/gcTime Infinity, então um primeiro fetch com erro nunca fica stale e
// nunca é refeito: o estado dura a sessão inteira).
vi.mock('@/features/whatsapp/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/whatsapp/api')>()),
  useProviderInfo: () => undefined,
}));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children, ...rest }: { to: string; children: React.ReactNode } & Record<string, unknown>) => (
    <a href={to} {...rest}>{children}</a>
  ),
}));

import { MessageComposer } from './message-composer';

describe('MessageComposer sem info do provider carregada (query em voo ou com erro)', () => {
  beforeEach(() => {
    sendMutate.mockClear();
    sendMediaMutate.mockClear();
    typingMutate.mockClear();
  });

  // FAIL-CLOSED: sem a info do provider (traits + capabilities) não dá para
  // saber se o canal tem caminho de envio nem se a janela de 24h está aberta.
  // O permissivo era regressão dupla — META (que NUNCA foi permissivo) abria
  // sem aviso, e TWILIO/ZERNIO com a janela fechada abriam texto e anexo,
  // indo tomar 409 do backend na cara do operador.
  it.each(['META', 'TWILIO', 'ZERNIO', 'EVOLUTION'] as const)(
    'trava o composer em %s enquanto a info do provider não chegou',
    (provider) => {
      render(<MessageComposer conversationId="c1" reply={null} onClearReply={() => {}} provider={provider} />);
      expect(screen.getByPlaceholderText('Escreva uma mensagem…')).toBeDisabled();
      expect(screen.getByLabelText('Enviar')).toBeDisabled();
      expect(screen.getByLabelText('Anexar')).toBeDisabled();
    },
  );

  // O banner "em breve" é uma AFIRMAÇÃO sobre o provider ("este canal ainda não
  // envia") — sem a info não se afirma nada. O estado neutro de carregamento é
  // o que aparece.
  it.each(['META', 'TWILIO'] as const)(
    'não mostra o banner "em breve" em %s — mostra o estado neutro de carregamento',
    (provider) => {
      render(<MessageComposer conversationId="c1" reply={null} onClearReply={() => {}} provider={provider} />);
      expect(screen.queryByTestId('provider-not-supported-banner')).toBeNull();
      expect(screen.queryByTestId('twilio-window-closed-banner')).toBeNull();
      expect(screen.queryByTestId('twilio-window-badge')).toBeNull();
      expect(screen.getByTestId('provider-traits-loading')).toBeInTheDocument();
    },
  );

  it('não envia no Enter nem emite typing enquanto a info do provider não chegou (META)', () => {
    render(<MessageComposer conversationId="c1" reply={null} onClearReply={() => {}} provider="META" />);
    const textarea = screen.getByPlaceholderText('Escreva uma mensagem…') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'oi' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(textarea.value).toBe('');
    expect(sendMutate).not.toHaveBeenCalled();
    expect(typingMutate).not.toHaveBeenCalled();
  });

  it('não faz upload de anexo enquanto a info do provider não chegou (TWILIO)', async () => {
    render(<MessageComposer conversationId="c1" reply={null} onClearReply={() => {}} provider="TWILIO" />);
    const input = screen.getByTestId('chat-file-input') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['x'], 'a.png', { type: 'image/png' })] } });
    await new Promise((r) => setTimeout(r, 0));
    expect(sendMediaMutate).not.toHaveBeenCalled();
  });

  // Ramo DIFERENTE e intocado: `provider === undefined` é dado ausente/legado da
  // conversa, não info em voo. Continua permissivo — o fail-closed acima não
  // pode ter vazado para cá.
  it('provider ausente (dado legado) continua permissivo — ramo não tocado', () => {
    render(<MessageComposer conversationId="c1" reply={null} onClearReply={() => {}} />);
    expect(screen.getByPlaceholderText('Escreva uma mensagem…')).not.toBeDisabled();
    expect(screen.getByLabelText('Anexar')).not.toBeDisabled();
    expect(screen.queryByTestId('provider-not-supported-banner')).toBeNull();
    expect(screen.queryByTestId('provider-traits-loading')).toBeNull();
  });
});
