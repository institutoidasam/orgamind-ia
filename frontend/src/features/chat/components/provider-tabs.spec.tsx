import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const providersData: { providers: Array<{ provider: string; channels: unknown[] }> } = {
  providers: [
    { provider: 'EVOLUTION', channels: [] },
    { provider: 'ZERNIO', channels: [] },
  ],
};
vi.mock('@/features/whatsapp/api', () => ({
  useProviders: () => ({ data: providersData }),
  // provider-scope.tsx (imported for real by provider-tabs.tsx for
  // PROVIDER_LABEL/ProviderScope) reads this constant at module scope.
  CHANNEL_PROVIDERS: ['EVOLUTION', 'TWILIO', 'ZERNIO', 'META', 'GOZAP'],
}));

import { ProviderTabs } from './provider-tabs';

describe('ProviderTabs', () => {
  it('renders nothing when fewer than 2 providers are configured', () => {
    providersData.providers = [{ provider: 'EVOLUTION', channels: [] }];
    const { container } = render(<ProviderTabs value="all" onChange={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders "Todos" + one tab per provider (PT-BR label) when 2+', () => {
    providersData.providers = [
      { provider: 'EVOLUTION', channels: [] },
      { provider: 'ZERNIO', channels: [] },
    ];
    render(<ProviderTabs value="all" onChange={vi.fn()} />);
    expect(screen.getByText('Todos')).toBeInTheDocument();
    expect(screen.getByText('Evolution')).toBeInTheDocument();
    expect(screen.getByText('Zernio')).toBeInTheDocument();
  });

  it('calls onChange with the provider when a tab is clicked, "all" for Todos', () => {
    providersData.providers = [
      { provider: 'EVOLUTION', channels: [] },
      { provider: 'ZERNIO', channels: [] },
    ];
    const onChange = vi.fn();
    render(<ProviderTabs value="all" onChange={onChange} />);
    fireEvent.click(screen.getByText('Zernio'));
    expect(onChange).toHaveBeenCalledWith('ZERNIO');
    fireEvent.click(screen.getByText('Todos'));
    expect(onChange).toHaveBeenCalledWith('all');
  });

  it('renders the PROVEDOR group label when tabs are visible', () => {
    providersData.providers = [
      { provider: 'EVOLUTION', channels: [] },
      { provider: 'ZERNIO', channels: [] },
    ];
    render(<ProviderTabs value="all" onChange={vi.fn()} />);
    expect(screen.getByText('provedor')).toBeInTheDocument(); // uppercase via CSS
  });

  // Pedido do cliente (2026-08-25): TWILIO nunca é oferecido aqui, mesmo
  // configurado no backend — o enum/tipo do provider continua intacto, só a
  // oferta na UI do inbox some.
  describe('ajuste do cliente — TWILIO fora, GOZAP primeiro (2026-08-25)', () => {
    it('nunca oferece TWILIO como aba, mesmo configurado', () => {
      providersData.providers = [
        { provider: 'EVOLUTION', channels: [] },
        { provider: 'TWILIO', channels: [] },
        { provider: 'ZERNIO', channels: [] },
      ];
      render(<ProviderTabs value="all" onChange={vi.fn()} />);
      expect(screen.getByText('Evolution')).toBeInTheDocument();
      expect(screen.getByText('Zernio')).toBeInTheDocument();
      expect(screen.queryByText('Twilio')).not.toBeInTheDocument();
    });

    // Com TWILIO filtrado, sobra só 1 provider ofertável (EVOLUTION) — não há
    // o que desambiguar, então a barra some por inteiro (mesma regra do
    // "fewer than 2" de sempre, agora contando só quem é OFERECIDO).
    it('some por inteiro quando só EVOLUTION e TWILIO estão configurados (TWILIO filtrado deixa 1 ofertável)', () => {
      providersData.providers = [
        { provider: 'EVOLUTION', channels: [] },
        { provider: 'TWILIO', channels: [] },
      ];
      const { container } = render(<ProviderTabs value="all" onChange={vi.fn()} />);
      expect(container).toBeEmptyDOMElement();
    });

    it('GOZAP aparece SEMPRE primeiro, logo após "Todos", não importa a ordem que a API devolveu', () => {
      providersData.providers = [
        { provider: 'EVOLUTION', channels: [] },
        { provider: 'ZERNIO', channels: [] },
        { provider: 'GOZAP', channels: [] },
      ];
      render(<ProviderTabs value="all" onChange={vi.fn()} />);
      const labels = screen.getAllByRole('button').map((b) => b.textContent);
      expect(labels).toEqual(['Todos', 'GoZap', 'Evolution', 'Zernio']);
    });
  });
});
