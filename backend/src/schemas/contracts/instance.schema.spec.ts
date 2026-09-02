import { describe, it, expect } from 'vitest';
import { createChannelSchema, channelSummarySchema, providersResponseSchema } from './instance.schema';

describe('createChannelSchema (POST /whatsapp/channels)', () => {
  const valid = {
    provider: 'TWILIO' as const,
    name: 'Vendas Twilio',
    phoneE164: '+5592987654321',
  };

  it('accepts a valid cloud-channel payload', () => {
    expect(() => createChannelSchema.parse(valid)).not.toThrow();
  });

  it('accepts an optional twilioMessagingServiceSid', () => {
    const parsed = createChannelSchema.parse({
      ...valid,
      twilioMessagingServiceSid: 'MGxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    });
    expect(parsed.twilioMessagingServiceSid).toBe(
      'MGxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    );
  });

  // The schema itself accepts the FULL ChannelProvider enum (including
  // EVOLUTION) so a caller sending provider='EVOLUTION' reaches the
  // controller and gets a specific PT-BR domain error (existing instance
  // flow) instead of a generic zod validation failure.
  it('accepts EVOLUTION at the schema level (rejection happens as a domain error downstream)', () => {
    expect(() =>
      createChannelSchema.parse({ ...valid, provider: 'EVOLUTION' }),
    ).not.toThrow();
  });

  it('rejects an unknown provider value', () => {
    const result = createChannelSchema.safeParse({ ...valid, provider: 'SMTP' });
    expect(result.success).toBe(false);
  });

  it.each([
    'not-a-phone',
    '5592987654321', // missing leading +
    '+abc',
    '',
  ])('rejects a non-E164 phoneE164 (%s)', (phoneE164) => {
    const result = createChannelSchema.safeParse({ ...valid, phoneE164 });
    expect(result.success).toBe(false);
  });

  it('rejects a name shorter than 2 chars', () => {
    const result = createChannelSchema.safeParse({ ...valid, name: 'A' });
    expect(result.success).toBe(false);
  });

  it('rejects a missing provider/name/phoneE164', () => {
    expect(createChannelSchema.safeParse({}).success).toBe(false);
  });

  it('requires phoneE164 for a non-ZERNIO provider (omitted)', () => {
    const { phoneE164: _drop, ...withoutPhone } = valid;
    const result = createChannelSchema.safeParse(withoutPhone);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((i) => i.path.join('.') === 'phoneE164'),
      ).toBe(true);
    }
  });

  describe('provider = ZERNIO', () => {
    const zernioValid = {
      provider: 'ZERNIO' as const,
      name: 'Vendas Zernio',
      phoneE164: '+5592987654321',
      zernioAccountId: 'acc-123',
    };

    it('accepts a valid Zernio payload with zernioAccountId', () => {
      expect(() => createChannelSchema.parse(zernioValid)).not.toThrow();
    });

    it('accepts a Zernio payload WITHOUT phoneE164 (the number lives on the Zernio account)', () => {
      const { phoneE164: _drop, ...noPhone } = zernioValid;
      expect(() => createChannelSchema.parse(noPhone)).not.toThrow();
    });

    it('requires zernioAccountId when provider is ZERNIO', () => {
      const { zernioAccountId: _drop, ...withoutAccountId } = zernioValid;
      const result = createChannelSchema.safeParse(withoutAccountId);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(
          result.error.issues.some(
            (i) =>
              i.path.join('.') === 'zernioAccountId' &&
              /obrigat[óo]rio/i.test(i.message),
          ),
        ).toBe(true);
      }
    });

    it('rejects an empty-string zernioAccountId when provider is ZERNIO', () => {
      const result = createChannelSchema.safeParse({
        ...zernioValid,
        zernioAccountId: '',
      });
      expect(result.success).toBe(false);
    });
  });

  it('does not require zernioAccountId for TWILIO (phoneE164 remains the required field)', () => {
    expect(() => createChannelSchema.parse(valid)).not.toThrow();
  });

  describe('provider = GOZAP', () => {
    // GOZAP pareia por QR (sessionBased) — o número só é conhecido depois do
    // pareamento, então nem phoneE164 nem zernioAccountId são exigidos aqui.
    it('accepts a GOZAP payload WITHOUT phoneE164 and WITHOUT zernioAccountId', () => {
      expect(() =>
        createChannelSchema.parse({ provider: 'GOZAP', name: 'Canal GoZap' }),
      ).not.toThrow();
    });
  });

  it('accepts an optional zernioAccountId even for a non-ZERNIO provider', () => {
    const parsed = createChannelSchema.parse({
      ...valid,
      zernioAccountId: 'acc-999',
    });
    expect(parsed.zernioAccountId).toBe('acc-999');
  });
});

describe('channelSummarySchema / providersResponseSchema (GET /whatsapp/providers)', () => {
  it('parses a full providers response payload matching the frontend contract', () => {
    const payload = {
      providers: [
        {
          provider: 'EVOLUTION',
          // F0: traits + capabilities declaradas do adapter (ver
          // PROVIDER_TRAITS / ProviderProfile).
          traits: { official: false, sessionBased: true, sessionWindow: false },
          capabilities: ['campaignSend', 'statusPolling'],
          channels: [
            {
              id: 'c1',
              name: 'Default',
              phoneE164: '+5592987654321',
              isActive: true,
              isDefault: true,
              provider: 'EVOLUTION',
            },
          ],
        },
        {
          provider: 'TWILIO',
          traits: { official: true, sessionBased: false, sessionWindow: true },
          capabilities: [],
          channels: [],
        },
      ],
    };
    expect(() => providersResponseSchema.parse(payload)).not.toThrow();
  });

  it('channelSummarySchema allows a null phoneE164 (not yet paired)', () => {
    const parsed = channelSummarySchema.parse({
      id: 'c1',
      name: 'Default',
      phoneE164: null,
      isActive: true,
      isDefault: false,
      provider: 'EVOLUTION',
    });
    expect(parsed.phoneE164).toBeNull();
  });

  // T15 — a quota do canal (dailySendLimit/sentToday/warmupEffectiveCap/
  // warming/warmupDay/sentTodayResetAt) vale para TODO provedor, não só
  // EVOLUTION (GET /whatsapp/instances). Os 6 campos são OPCIONAIS no
  // contrato — um cliente antigo (ou um payload de teste que não os manda)
  // não pode quebrar — mas o service (whatsapp-providers.controller.ts)
  // sempre os preenche.
  it('channelSummarySchema aceita os 6 campos novos de quota (todo provedor)', () => {
    const parsed = channelSummarySchema.parse({
      id: 'g1',
      name: 'Canal GoZap',
      phoneE164: '+5592987654321',
      isActive: true,
      isDefault: true,
      provider: 'GOZAP',
      dailySendLimit: 500,
      sentToday: 120,
      sentTodayResetAt: '2026-08-24T13:00:00.000Z',
      warmupEffectiveCap: 500,
      warming: false,
      warmupDay: 0,
    });
    expect(parsed).toMatchObject({
      dailySendLimit: 500,
      sentToday: 120,
      sentTodayResetAt: '2026-08-24T13:00:00.000Z',
      warmupEffectiveCap: 500,
      warming: false,
      warmupDay: 0,
    });
  });

  it('channelSummarySchema também aceita null em sentTodayResetAt', () => {
    expect(() =>
      channelSummarySchema.parse({
        id: 'g1',
        name: 'Canal GoZap',
        phoneE164: null,
        isActive: true,
        isDefault: true,
        provider: 'GOZAP',
        sentTodayResetAt: null,
      }),
    ).not.toThrow();
  });

  it('channelSummarySchema continua aceitando um payload SEM os campos novos (cliente antigo)', () => {
    const parsed = channelSummarySchema.parse({
      id: 'c1',
      name: 'Default',
      phoneE164: '+5592987654321',
      isActive: true,
      isDefault: true,
      provider: 'EVOLUTION',
    });
    expect(parsed.dailySendLimit).toBeUndefined();
    expect(parsed.sentToday).toBeUndefined();
  });

  // connectionState — o estado de conexão mais recente do canal (Fase A,
  // docs/superpowers/plans/2026-08-25-fase-a-canais-e-inbox.md). Entrou sem
  // teste de contrato próprio; este describe cobre os 3 estados válidos, o
  // `null` (canal oficial sem sessão — NÃO é "desconectado") e a rejeição de
  // um valor fora do enum.
  describe('connectionState', () => {
    const base = {
      id: 'g1',
      name: 'Canal GoZap',
      phoneE164: '+5592987654321',
      isActive: true,
      isDefault: true,
      provider: 'GOZAP' as const,
    };

    it.each(['open', 'connecting', 'close'] as const)(
      'aceita o estado válido "%s"',
      (state) => {
        const parsed = channelSummarySchema.parse({ ...base, connectionState: state });
        expect(parsed.connectionState).toBe(state);
      },
    );

    // Canal oficial (TWILIO/ZERNIO/META) não tem sessão: `null` é um estado
    // DIFERENTE de "close" — nunca inventar um "desconectado" que não existe.
    it('aceita null (canal sem sessão, ou sessionBased que nunca conectou)', () => {
      const parsed = channelSummarySchema.parse({ ...base, connectionState: null });
      expect(parsed.connectionState).toBeNull();
    });

    it('aceita a ausência do campo (cliente antigo)', () => {
      const parsed = channelSummarySchema.parse(base);
      expect(parsed.connectionState).toBeUndefined();
    });

    it('rejeita um valor fora do enum', () => {
      const result = channelSummarySchema.safeParse({
        ...base,
        connectionState: 'reconnecting',
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(
          result.error.issues.some((i) => i.path.join('.') === 'connectionState'),
        ).toBe(true);
      }
    });
  });
});
