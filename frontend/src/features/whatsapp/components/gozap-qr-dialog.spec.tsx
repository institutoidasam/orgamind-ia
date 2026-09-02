import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Mutable QR result so individual tests control what `useGozapQr` returns.
let mockQrData: { state: 'open' | 'connecting' | 'close'; qrBase64?: string } | undefined;
// Records every id `useGozapQr` is polled with — asserts the poll is
// disabled (id === undefined) while the dialog is closed.
const qrIdCalls: (string | undefined)[] = [];
// O botão "Tentar novamente" é o ÚNICO remédio do operador quando o QR não
// vem (o GoZap recusa `/instance/connect` por alguns segundos após criar a
// instância). Sem este espião, o mock não expunha `refetch` e um `onRetry`
// mal fiado passaria despercebido — o botão apareceria e não faria nada.
const refetchMock = vi.fn();

vi.mock('../api', () => ({
  useGozapQr: (id?: string) => {
    qrIdCalls.push(id);
    return { data: mockQrData, refetch: refetchMock, isFetching: false, isError: false };
  },
}));

import { GozapQrDialog } from './gozap-qr-dialog';

let queryClient: QueryClient;

function wrap(ui: React.ReactElement) {
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

describe('GozapQrDialog', () => {
  beforeEach(() => {
    mockQrData = undefined;
    qrIdCalls.length = 0;
    refetchMock.mockClear();
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  it('o botão "Tentar novamente" realmente dispara uma nova busca do QR', () => {
    mockQrData = { state: 'close' };
    wrap(
      <GozapQrDialog channelId="ch1" channelName="Loja 1" open={true} onOpenChange={() => {}} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }));

    expect(refetchMock).toHaveBeenCalledTimes(1);
  });

  it('renders the QR image when qrBase64 comes back', () => {
    mockQrData = { state: 'close', qrBase64: 'ABCD' };
    wrap(
      <GozapQrDialog channelId="ch1" channelName="Loja 1" open={true} onOpenChange={() => {}} />,
    );

    const img = screen.getByAltText('QR code para parear o WhatsApp');
    expect(img).toHaveAttribute('src', 'data:image/png;base64,ABCD');
  });

  it('shows unavailable notice and retry button when state is "close" without qrBase64', () => {
    mockQrData = { state: 'close' };
    wrap(
      <GozapQrDialog channelId="ch1" channelName="Loja 1" open={true} onOpenChange={() => {}} />,
    );
    expect(screen.queryByAltText('QR code para parear o WhatsApp')).not.toBeInTheDocument();
    expect(
      screen.getByText(
        'Código QR temporariamente indisponível. Aguarde a inicialização da instância ou tente novamente.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Tentar novamente' })).toBeInTheDocument();
  });

  /**
   * INCIDENTE 2026-08-07. O backend passou a gravar o `phoneE164` do canal
   * GOZAP ao ver a sessão viva, e é esse campo que o assistente de campanha usa
   * como prova de conexão (`campaigns/new.tsx`: rádio `disabled={!c.phoneE164}`,
   * rótulo `{c.phoneE164 ?? 'desconectada'}`). Mas ele vem de `useProviders`,
   * que é `staleTime: Infinity` + `gcTime: Infinity`. Sem invalidar aqui, o
   * operador vê "Conectado!" e mesmo assim encontra o canal como "desconectada"
   * e inselecionável até dar F5 — o que anularia, na prática, a correção
   * inteira do backend.
   */
  it('ao parear, invalida a lista de canais (senão o cache Infinity mantém "desconectada")', () => {
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    mockQrData = { state: 'open' };

    wrap(<GozapQrDialog channelId="ch1" channelName="Loja 1" open={true} onOpenChange={() => {}} />);

    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['whatsapp', 'providers'] });
  });

  it('enquanto NÃO pareou, não invalida nada (evita refetch a cada poll de 3s)', () => {
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    mockQrData = { state: 'connecting', qrBase64: 'ABCD' };

    wrap(<GozapQrDialog channelId="ch1" channelName="Loja 1" open={true} onOpenChange={() => {}} />);

    expect(invalidate).not.toHaveBeenCalled();
  });

  it('shows the connected confirmation once state is "open"', () => {
    mockQrData = { state: 'open' };
    wrap(
      <GozapQrDialog channelId="ch1" channelName="Loja 1" open={true} onOpenChange={() => {}} />,
    );
    expect(screen.getByText('Conectado!')).toBeInTheDocument();
  });

  it('does not poll (channelId undefined) while the dialog is closed', () => {
    wrap(
      <GozapQrDialog channelId="ch1" channelName="Loja 1" open={false} onOpenChange={() => {}} />,
    );
    expect(qrIdCalls.length).toBeGreaterThan(0);
    expect(qrIdCalls.every((id) => id === undefined)).toBe(true);
  });

  it('polls with the real channelId once open', () => {
    mockQrData = { state: 'connecting' };
    wrap(
      <GozapQrDialog channelId="ch1" channelName="Loja 1" open={true} onOpenChange={() => {}} />,
    );
    expect(qrIdCalls).toContain('ch1');
  });
});
