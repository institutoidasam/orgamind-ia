import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

/**
 * O chip "Conexões" do topbar mentia em produção: mostrava "Conexões: 0/2"
 * (duas instâncias Evolution zumbis, presas em `connecting`) enquanto o canal
 * ZERNIO — o que de fato envia e recebe — estava ativo e operando. O operador
 * lia "nada conectado" num sistema funcionando.
 *
 * A causa: canal cloud (ZERNIO/TWILIO/META) não tem handshake Evolution, logo
 * nunca tem `lastConnectionState === 'open'` — e era esse o único critério de
 * "online". O critério certo por família:
 * - EVOLUTION: online = sessão pareada (`open`);
 * - cloud: online = canal ATIVO (é o mesmo critério da barra de abas do
 *   inbox — ver conversations-list.tsx, T7).
 */
type InstanceStub = { id: string; name: string; lastConnectionState: string | null };
type ChannelStub = { id: string; name: string; isActive: boolean };
type ProviderTraitsStub = { official: boolean; sessionBased: boolean; sessionWindow: boolean };
// Traits REAIS que o backend expõe hoje por provider (contrato da Task 4) —
// fixture usada pelos grupos de /providers abaixo, não uma asserção do gate.
const TRAITS_BY_PROVIDER: Record<string, ProviderTraitsStub> = {
  EVOLUTION: { official: false, sessionBased: true, sessionWindow: false },
  TWILIO: { official: true, sessionBased: false, sessionWindow: true },
  ZERNIO: { official: true, sessionBased: false, sessionWindow: true },
  META: { official: true, sessionBased: false, sessionWindow: false },
};

let instancesData: InstanceStub[] | undefined;
let providersData:
  | { providers: Array<{ provider: string; traits: ProviderTraitsStub; channels: ChannelStub[] }> }
  | undefined;

vi.mock('@/features/whatsapp/api', () => ({
  useInstances: () => ({ data: instancesData }),
  useProviders: () => ({ data: providersData }),
}));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, ...rest }: { children: React.ReactNode; to: string }) => (
    <a href={to} {...rest}>{children}</a>
  ),
}));

import { WhatsappStatusIndicator } from './whatsapp-status-indicator';

const evo = (over: Partial<InstanceStub> = {}): InstanceStub => ({
  id: 'i1', name: 'Atendimento 01', lastConnectionState: 'connecting', ...over,
});
const zernio = (over: Partial<ChannelStub> = {}): ChannelStub => ({
  id: 'z1', name: 'Matheus Garcia', isActive: true, ...over,
});

beforeEach(() => {
  instancesData = [];
  providersData = { providers: [] };
});

describe('WhatsappStatusIndicator — canais cloud contam como conexão', () => {
  it('não renderiza nada quando não há conexão nenhuma configurada', () => {
    const { container } = render(<WhatsappStatusIndicator />);
    expect(container).toBeEmptyDOMElement();
  });

  it('o cenário de prod: 2 Evolution presas em connecting + 1 ZERNIO ativo = 1/3, não 0/2', () => {
    instancesData = [evo(), evo({ id: 'i2', name: 'QRCode' })];
    providersData = {
      providers: [{ provider: 'ZERNIO', traits: TRAITS_BY_PROVIDER.ZERNIO, channels: [zernio()] }],
    };

    render(<WhatsappStatusIndicator />);

    expect(screen.getByText('Conexões: 1/3')).toBeInTheDocument();
  });

  it('sozinho, o canal cloud ATIVO aparece como pill único e online', () => {
    providersData = { providers: [{ provider: 'ZERNIO', traits: TRAITS_BY_PROVIDER.ZERNIO, channels: [zernio()] }] };

    render(<WhatsappStatusIndicator />);

    // Pill único mostra o nome do canal (mesmo formato do Evolution único).
    expect(screen.getByText('Matheus Garcia')).toBeInTheDocument();
    expect(screen.queryByText(/Conexões:/)).not.toBeInTheDocument();
  });

  it('canal cloud INATIVO (soft-deleted) não conta como conexão', () => {
    instancesData = [evo({ lastConnectionState: 'open' })];
    providersData = {
      providers: [{ provider: 'ZERNIO', traits: TRAITS_BY_PROVIDER.ZERNIO, channels: [zernio({ isActive: false })] }],
    };

    render(<WhatsappStatusIndicator />);

    // Sobrou só o Evolution → pill único, sem contador.
    expect(screen.getByText('Atendimento 01')).toBeInTheDocument();
    expect(screen.queryByText(/Conexões:/)).not.toBeInTheDocument();
  });

  it('Evolution continua exigindo sessão pareada: só `open` conta como online', () => {
    instancesData = [evo({ lastConnectionState: 'open' }), evo({ id: 'i2', name: 'QRCode' })];

    render(<WhatsappStatusIndicator />);

    expect(screen.getByText('Conexões: 1/2')).toBeInTheDocument();
  });

  it('canais do grupo EVOLUTION em /providers não entram duas vezes na conta', () => {
    // GET /whatsapp/instances já traz os Evolution; o grupo EVOLUTION de
    // /providers é a MESMA coisa por outra rota — somar os dois duplicaria.
    instancesData = [evo({ lastConnectionState: 'open' })];
    providersData = {
      providers: [
        {
          provider: 'EVOLUTION',
          traits: TRAITS_BY_PROVIDER.EVOLUTION,
          channels: [{ id: 'i1', name: 'Atendimento 01', isActive: true }],
        },
        { provider: 'ZERNIO', traits: TRAITS_BY_PROVIDER.ZERNIO, channels: [zernio()] },
      ],
    };

    render(<WhatsappStatusIndicator />);

    expect(screen.getByText('Conexões: 2/2')).toBeInTheDocument();
  });
});
