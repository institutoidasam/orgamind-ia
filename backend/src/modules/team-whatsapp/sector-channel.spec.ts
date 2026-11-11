import { describe, expect, it } from 'vitest';
import type { ChannelProvider } from '@prisma/client';
import { effectiveChannel, type SectorChannelRow } from './sector-channel';

const row = (
  provider: ChannelProvider,
  isActive: boolean,
): SectorChannelRow => ({
  id: 'ch-1',
  name: 'GBR',
  phoneE164: '+5592999991111',
  provider,
  isActive,
});

describe('effectiveChannel (número efetivo da área, D2)', () => {
  it.each([
    ['GOZAP ativo', row('GOZAP', true), 'GOZAP'],
    ['EVOLUTION ativo', row('EVOLUTION', true), 'EVOLUTION'],
  ] as const)(
    '%s vira a referência sem isActive',
    (_label, input, provider) => {
      expect(effectiveChannel(input)).toEqual({
        id: 'ch-1',
        name: 'GBR',
        phoneE164: '+5592999991111',
        provider,
      });
    },
  );

  it.each([
    ['GOZAP inativo', row('GOZAP', false)],
    ['TWILIO ativo', row('TWILIO', true)],
    ['ZERNIO ativo', row('ZERNIO', true)],
    ['sem canal', null],
  ] as const)('%s não é número efetivo', (_label, input) => {
    expect(effectiveChannel(input)).toBeNull();
  });
});
