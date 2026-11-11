import { describe, expect, it } from 'vitest';
import type { LiveCheck } from '../whatsapp-providers/channel-live-state.service';
import {
  distinctLiveChannels,
  liveBlock,
  missingSectors,
  previewChannels,
  recipientChannel,
  requireOpenNumbers,
  requireSectorNumbers,
  singleChannelId,
  toTeamSectorChannel,
} from './team-whatsapp.channels';

const check = (state: LiveCheck['state'], channelId = 'c1'): LiveCheck => ({
  channelId,
  state,
  checkedAt: new Date('2026-11-10T12:00:00.000Z'),
});
const ref = {
  id: 'c1',
  name: 'GBR',
  phoneE164: '+5592999991111',
  provider: 'GOZAP' as const,
};

describe('liveBlock (só open libera; close/connecting vencem unknown)', () => {
  it.each([
    ['todos abertos', [check('open'), check('open', 'c2')], null],
    [
      'um aberto e um desconhecido',
      [check('open'), check('unknown', 'c2')],
      'team_whatsapp.channel_unverified',
    ],
    [
      'desconhecido e fechado: o fechado vence',
      [check('unknown'), check('close', 'c2')],
      'team_whatsapp.channel_disconnected',
    ],
    ['conectando', [check('connecting')], 'team_whatsapp.channel_disconnected'],
  ])('%s', (_caso, checks, expected) => {
    expect(liveBlock(checks)).toBe(expected);
  });
});

describe('missingSectors', () => {
  it('devolve só as áreas sem número, na ordem recebida', () => {
    const out = missingSectors([
      { id: 's1', name: 'Logística', channel: null },
      { id: 's2', name: 'Expedição', channel: ref },
      { id: 's3', name: 'Produção', channel: null },
    ]);
    expect(out).toEqual([
      { id: 's1', name: 'Logística' },
      { id: 's3', name: 'Produção' },
    ]);
  });
});

describe('toTeamSectorChannel', () => {
  it('junta o número e o estado ao vivo, com checkedAt em ISO', () => {
    expect(toTeamSectorChannel(ref, check('open'))).toEqual({
      ...ref,
      live: { state: 'open', checkedAt: '2026-11-10T12:00:00.000Z' },
    });
  });
});

const row = { ...ref, evolutionInstanceName: 'inst-1' };
const NOW = new Date('2026-11-10T13:00:00.000Z');

describe('distinctLiveChannels', () => {
  it('um canal por id, sem os setores sem número', () => {
    expect(distinctLiveChannels([row, null, row])).toEqual([
      { id: 'c1', provider: 'GOZAP', evolutionInstanceName: 'inst-1' },
    ]);
  });
});

describe('previewChannels', () => {
  it('sem número → null; sem resposta da porta → unknown, nunca open', () => {
    const out = previewChannels(
      new Map([
        ['s1', row],
        ['s2', null],
        ['s3', { ...row, id: 'c9' }],
      ]),
      new Map([['c1', check('open')]]),
      NOW,
    );
    expect(out.get('s2')).toBeNull();
    expect(out.get('s1')?.live.state).toBe('open');
    expect(out.get('s3')?.live).toEqual({
      state: 'unknown',
      checkedAt: NOW.toISOString(),
    });
    expect(out.get('s1')).not.toHaveProperty('evolutionInstanceName');
  });
});

describe('número do envio (T8)', () => {
  it('recipientChannel: sem número é erro, nunca outro número', () => {
    expect(recipientChannel(ref)).toEqual({
      channelId: 'c1',
      channelName: 'GBR',
      channelPhoneE164: '+5592999991111',
    });
    expect(() => recipientChannel(undefined)).toThrow(
      expect.objectContaining({ code: 'team_whatsapp.sector_without_number' }),
    );
  });

  it('requireSectorNumbers: uma área sem número trava o envio inteiro', () => {
    const sectors = [
      { id: 's1', name: 'Logística' },
      { id: 's2', name: 'Expedição' },
    ];
    expect(
      requireSectorNumbers(
        sectors,
        new Map([
          ['s1', row],
          ['s2', row],
        ]),
      ).size,
    ).toBe(2);
    expect(() => requireSectorNumbers(sectors, new Map([['s1', row]]))).toThrow(
      expect.objectContaining({ code: 'team_whatsapp.sector_without_number' }),
    );
  });

  it('requireOpenNumbers: só open libera; sem resposta da porta vale unknown', () => {
    const involved = distinctLiveChannels([row]);
    expect(() =>
      requireOpenNumbers(involved, new Map([['c1', check('open')]]), NOW),
    ).not.toThrow();
    expect(() => requireOpenNumbers(involved, new Map(), NOW)).toThrow(
      expect.objectContaining({ code: 'team_whatsapp.channel_unverified' }),
    );
  });

  it('singleChannelId: o canal de um número só; null com mais de um', () => {
    expect(singleChannelId(['c1'])).toBe('c1');
    expect(singleChannelId(['c1', 'c2'])).toBeNull();
  });
});
