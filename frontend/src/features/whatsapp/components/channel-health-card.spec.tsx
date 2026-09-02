import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { ChannelHealthCard } from './channel-health-card';
import type { ChannelHealth } from '../api';

function health(overrides: Partial<ChannelHealth> = {}): ChannelHealth {
  return {
    channelId: 'ch_1',
    channelName: 'Canal do Matheus',
    provider: 'ZERNIO',
    zernioAccountId: 'acc_1',
    displayPhoneNumber: '+55 92 3155-0101',
    messagingLimitTier: 'TIER_2K',
    tierLimit: 2000,
    uniqueRecipients24h: 300,
    tierUsagePct: 15,
    nearTierLimit: false,
    qualityRating: 'GREEN',
    nameStatus: 'APPROVED',
    stale: false,
    syncedAt: new Date(),
    ...overrides,
  };
}

describe('ChannelHealthCard', () => {
  it('mostra o tier e QUANTO dele já foi gasto nas últimas 24h', () => {
    render(<ChannelHealthCard health={health()} />);

    expect(screen.getByText(/TIER_2K/)).toBeInTheDocument();
    // O denominador é o teto de usuários ÚNICOS/24h — não "mensagens hoje".
    expect(screen.getByText(/300\s*\/\s*2\.?000/)).toBeInTheDocument();
    expect(screen.getByText(/destinatários únicos/i)).toBeInTheDocument();
  });

  // >80% do teto: o operador precisa PARAR antes de estourar. Estourar faz a
  // Meta rejeitar em massa → quality rating despenca → o tier CAI.
  it('alerta ao se aproximar do teto (>80%)', () => {
    render(
      <ChannelHealthCard
        health={health({
          uniqueRecipients24h: 1700,
          tierUsagePct: 85,
          nearTierLimit: true,
        })}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent(/85%/);
    expect(screen.getByRole('alert')).toHaveTextContent(/teto/i);
  });

  it('não alerta quando está longe do teto', () => {
    render(<ChannelHealthCard health={health({ tierUsagePct: 15 })} />);

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it.each([
    ['GREEN', 'Boa'],
    ['YELLOW', 'Média'],
    ['RED', 'Ruim'],
    ['UNKNOWN', 'Sem dados'],
  ])('mostra o quality rating %s como "%s"', (rating, label) => {
    render(<ChannelHealthCard health={health({ qualityRating: rating })} />);

    expect(screen.getByTestId('quality-rating')).toHaveTextContent(label);
  });

  // O CASO REAL DO CLIENTE HOJE: os dois números estão com o nome de exibição
  // reprovado pela Meta. O destinatário vê o NÚMERO, não o nome do negócio — o
  // que derruba a confiança e sobe a taxa de bloqueio/denúncia, que é justamente
  // o que despenca o quality rating. Isso não pode ser um detalhe discreto.
  it('destaca nameStatus DECLINED e explica o impacto em 1 linha', () => {
    render(
      <ChannelHealthCard
        health={health({
          nameStatus: 'DECLINED',
          nameRejectionReason: 'BIZ_COMMERCE_VIOLATION_OTHER',
        })}
      />,
    );

    const alerts = screen.getAllByRole('alert');
    const declined = alerts.find((a) =>
      /nome de exibição/i.test(a.textContent ?? ''),
    );
    expect(declined).toBeDefined();
    expect(declined).toHaveTextContent(/o destinatário vê o número/i);
    expect(declined).toHaveTextContent(/BIZ_COMMERCE_VIOLATION_OTHER/);
  });

  it('não mostra o alerta de nome quando o nameStatus está APPROVED', () => {
    render(<ChannelHealthCard health={health({ nameStatus: 'APPROVED' })} />);

    expect(screen.queryByText(/o destinatário vê o número/i)).not.toBeInTheDocument();
  });

  // LIMITED ≠ BLOCKED: o número ENVIA, mas capado — e o teto efetivo é menor do
  // que o TIER_2K nominal sugere. O motivo vem da própria Meta.
  it('mostra can_send_message LIMITED com o motivo da Meta', () => {
    render(
      <ChannelHealthCard
        health={health({
          canSendMessage: 'LIMITED',
          canSendMessageReason: 'Your display name has not been approved yet.',
        })}
      />,
    );

    expect(screen.getByTestId('can-send')).toHaveTextContent(/limitado/i);
    expect(
      screen.getByText(/Your display name has not been approved yet\./),
    ).toBeInTheDocument();
  });

  it('mostra a data da última sincronização', () => {
    render(<ChannelHealthCard health={health()} />);

    expect(screen.getByTestId('synced-at')).toHaveTextContent(/sincronizado/i);
  });

  // Dado velho ROTULADO como velho. Sem isso, o operador acha que está vendo o
  // estado de agora e dispara confiante em cima de um número já queimado.
  it('avisa quando a leitura está desatualizada (stale)', () => {
    render(<ChannelHealthCard health={health({ stale: true })} />);

    expect(screen.getByTestId('synced-at')).toHaveTextContent(/cache|desatualizad/i);
  });
});
