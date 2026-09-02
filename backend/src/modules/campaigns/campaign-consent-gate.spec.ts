import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  mayStillSendToContact,
  type ConsentGateDeps,
  type ConsentGateCampaign,
} from './campaign-consent-gate';

/**
 * Regressão da Task 2 (F0 — modelo de capacidades), constatação Important
 * da revisão: `channel != null && !isOfficialProvider(channel.provider)`
 * concede o override (retorna `true`) quando `channel.provider` está
 * ausente/undefined — dado que `Channel.provider` nunca é nulo em produção
 * (coluna Prisma não-nula), essa combinação é inalcançável por dados reais,
 * mas a Global Constraint do plano exige tabela-verdade idêntica à do
 * código antigo (`channel?.provider === 'EVOLUTION'`) mesmo nos casos
 * degenerados — e o antigo retornava `false` (NEGA) para provider ausente.
 * Este arquivo fixa a versão corrigida (`channel?.provider != null && ...`)
 * para impedir que a regressão volte.
 */
function makeDeps(overrides: {
  hasConsent?: boolean;
  openWindow?: Set<string>;
  channel?: { provider: string } | null | { [k: string]: never };
}): ConsentGateDeps {
  return {
    consent: {
      hasConsent: vi.fn().mockResolvedValue(overrides.hasConsent ?? false),
    },
    campaignsRepo: {
      findContactsWithOpenWindow: vi
        .fn()
        .mockResolvedValue(overrides.openWindow ?? new Set()),
    },
    prisma: {
      channel: {
        findUnique: vi.fn().mockResolvedValue(overrides.channel ?? null),
      } as never,
    },
  };
}

const BASE_CAMPAIGN: ConsentGateCampaign = {
  purposeKey: 'campanha_apoio',
  override: true,
  overrideJustification: 'risco anti-ban reconhecido pelo operador',
};

describe('mayStillSendToContact — override sobrevivente por provider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('NEGA quando o canal existe mas o provider está ausente/undefined (caso degenerado, tabela-verdade idêntica ao código antigo)', async () => {
    const deps = makeDeps({ channel: {} as { provider: string } });

    const may = await mayStillSendToContact(
      deps,
      BASE_CAMPAIGN,
      'contact-1',
      'instance-1',
    );

    expect(may).toBe(false);
  });

  it('NEGA quando o canal não existe (findUnique retorna null)', async () => {
    const deps = makeDeps({ channel: null });

    const may = await mayStillSendToContact(
      deps,
      BASE_CAMPAIGN,
      'contact-1',
      'instance-1',
    );

    expect(may).toBe(false);
  });

  it('CONCEDE quando o provider é EVOLUTION (não-oficial) e a justificativa está presente', async () => {
    const deps = makeDeps({ channel: { provider: 'EVOLUTION' } });

    const may = await mayStillSendToContact(
      deps,
      BASE_CAMPAIGN,
      'contact-1',
      'instance-1',
    );

    expect(may).toBe(true);
  });

  it('NEGA quando o provider é oficial (TWILIO) — override é inexprimível em canal oficial', async () => {
    const deps = makeDeps({ channel: { provider: 'TWILIO' } });

    const may = await mayStillSendToContact(
      deps,
      BASE_CAMPAIGN,
      'contact-1',
      'instance-1',
    );

    expect(may).toBe(false);
  });
});
