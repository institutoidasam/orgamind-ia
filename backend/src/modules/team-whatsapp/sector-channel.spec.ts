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
  it('EVOLUTION ativo vira a referência sem isActive', () => {
    expect(effectiveChannel(row('EVOLUTION', true))).toEqual({
      id: 'ch-1',
      name: 'GBR',
      phoneE164: '+5592999991111',
      provider: 'EVOLUTION',
    });
  });

  it('canal GOZAP ativo → sem número (cenário 4)', () => {
    expect(effectiveChannel(row('GOZAP', true))).toBeNull();
  });

  it.each([
    ['GOZAP inativo', row('GOZAP', false)],
    ['TWILIO ativo', row('TWILIO', true)],
    ['ZERNIO ativo', row('ZERNIO', true)],
    ['sem canal', null],
  ] as const)('%s não é número efetivo', (_label, input) => {
    expect(effectiveChannel(input)).toBeNull();
  });
});
