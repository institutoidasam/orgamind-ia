import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WebhookDropsBanner } from './webhook-drops-banner';

let dropsState: { data?: { drops: unknown[] } } = { data: { drops: [] } };
vi.mock('../api', () => ({
  useWebhookDrops: () => dropsState,
}));

beforeEach(() => {
  dropsState = { data: { drops: [] } };
});

const DROP_ZERNIO = {
  provider: 'ZERNIO',
  accountRef: 'a1b2c3d4e5f6a7b8c9d0e1f2',
  totalCount: 33,
  events: ['message.delivered', 'message.read', 'message.received'],
  firstSeenAt: new Date('2026-07-10T10:00:00Z'),
  lastSeenAt: new Date('2026-07-10T13:00:00Z'),
};

/**
 * O banner é a peça que faltava no incidente: os webhooks chegavam, eram
 * descartados, e a interface não dizia NADA. ~100 mensagens se perderam com a
 * tela mostrando "tudo normal".
 */
describe('WebhookDropsBanner', () => {
  it('sem drops → não renderiza nada (nenhum alarme falso)', () => {
    dropsState = { data: { drops: [] } };
    const { container } = render(<WebhookDropsBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it('com drop → alerta com a conta, a contagem e o provedor', () => {
    dropsState = { data: { drops: [DROP_ZERNIO] } };
    render(<WebhookDropsBanner />);

    // A frase tem de dizer o que está ACONTECENDO (perda), não "aviso genérico".
    expect(screen.getByText(/perdendo mensagens e status/i)).toBeInTheDocument();
    // A conta órfã, para o operador saber exatamente qual canal criar.
    expect(screen.getByText(/a1b2c3d4e5f6a7b8c9d0e1f2/)).toBeInTheDocument();
    // A contagem, para dimensionar o estrago.
    expect(screen.getByText(/33/)).toBeInTheDocument();
    // O provedor é nomeado (aparece no título e no corpo do alerta).
    expect(screen.getAllByText(/Zernio/i).length).toBeGreaterThan(0);
  });

  it('um alerta por conta órfã', () => {
    dropsState = {
      data: {
        drops: [
          DROP_ZERNIO,
          {
            ...DROP_ZERNIO,
            provider: 'TWILIO',
            accountRef: '+5592999998888',
            totalCount: 4,
            events: ['inbound'],
          },
        ],
      },
    };
    render(<WebhookDropsBanner />);

    expect(screen.getAllByRole('alert')).toHaveLength(2);
    expect(screen.getByText(/\+5592999998888/)).toBeInTheDocument();
  });
});
