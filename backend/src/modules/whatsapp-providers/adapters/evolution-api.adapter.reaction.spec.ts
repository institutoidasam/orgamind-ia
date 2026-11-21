import { describe, expect, it } from 'vitest';
import { mockDeep } from 'vitest-mock-extended';
import type { ConfigService } from '@nestjs/config';
import { EvolutionApiAdapter } from './evolution-api.adapter';
import type { Env } from '../../../shared/config/env.schema';
import { isAckWord } from '../../team-whatsapp/team-alert.rules';

// Lote I, T5 (GI2): reação com joinha nunca vira ciência. A Evolution entrega a
// reação como `reactionMessage`, que o adaptador não extrai: vira UNSUPPORTED
// sem texto. Só teste; o adaptador não muda.
function makeAdapter() {
  const config = mockDeep<ConfigService<Env>>();
  config.get.mockImplementation((k: unknown) =>
    k === 'EVOLUTION_BASE_URL'
      ? 'https://evolution.test'
      : k === 'EVOLUTION_API_KEY'
        ? 'key'
        : undefined,
  );
  return new EvolutionApiAdapter(config);
}

describe('EvolutionApiAdapter — reação recebida (Lote I, T5)', () => {
  it('reação da Evolution vira UNSUPPORTED sem texto e isAckWord falso', () => {
    const [m] = makeAdapter().parseInboundChatMessages({
      event: 'messages.upsert',
      instance: 'picoa',
      data: {
        key: {
          remoteJid: '5592991110001@s.whatsapp.net',
          fromMe: false,
          id: 'REACT1',
        },
        message: {
          reactionMessage: {
            key: {
              remoteJid: '5592991110001@s.whatsapp.net',
              fromMe: true,
              id: 'ALERT1',
            },
            text: '👍',
          },
        },
        messageTimestamp: 1763042400,
      },
    });
    expect(m.kind).toBe('UNSUPPORTED');
    expect(m.text).toBeUndefined();
    expect(isAckWord({ kind: m.kind, text: m.text ?? null })).toBe(false);
  });
});
