import { describe, expect, it } from 'vitest';
import { channelAvailability } from './channel-availability';

const PHONE = '+5592991234567';

describe('channelAvailability', () => {
  it.each([
    ['open', PHONE, { usable: true }],
    ['close', PHONE, { usable: false, label: 'Desconectado' }],
    ['connecting', PHONE, { usable: false, label: 'Aguardando conexão' }],
    // Estado ausente nunca significa desconectado: o evento expira em 7 dias.
    [null, PHONE, { usable: true }],
    [null, null, { usable: false, label: 'Aguardando conexão' }],
  ] as const)('estado %s com telefone %s', (connectionState, phoneE164, expected) => {
    expect(channelAvailability({ connectionState, phoneE164 })).toEqual(expected);
  });
});
