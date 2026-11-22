import { describe, it, expect } from 'vitest';
import {
  EVOLUTION_WEBHOOK_EVENTS,
  buildWebhookSetBody,
  webhookDivergences,
  type ExpectedWebhook,
} from './evolution-webhook-config';

const expected: ExpectedWebhook = {
  url: 'https://orgamind.example.com/webhooks/whatsapp',
  apikey: 'GLOBAL-KEY',
};
const events = [...EVOLUTION_WEBHOOK_EVENTS];
const flat = {
  enabled: true,
  url: expected.url,
  events,
  headers: { apikey: 'GLOBAL-KEY' },
};

describe('webhookDivergences', () => {
  it.each([
    ['igual, forma plana', flat, []],
    ['igual, forma { webhook }', { webhook: flat }, []],
    ['enabled:false', { ...flat, enabled: false }, ['enabled']],
    [
      'url diferente',
      { ...flat, url: 'https://outro.example.com/webhooks' },
      ['url'],
    ],
    ['events em outra ordem', { ...flat, events: [...events].reverse() }, []],
    [
      'events sem QRCODE_UPDATED',
      { ...flat, events: events.filter((e) => e !== 'QRCODE_UPDATED') },
      ['events'],
    ],
    ['events vazio', { ...flat, events: [] }, ['events']],
    [
      'apikey diferente',
      { ...flat, headers: { apikey: 'OUTRA' } },
      ['headers.apikey'],
    ],
    [
      'headers como string JSON igual',
      { ...flat, headers: JSON.stringify({ apikey: 'GLOBAL-KEY' }) },
      [],
    ],
    ['null', null, ['enabled', 'url', 'events', 'headers.apikey']],
  ])('%s', (_name, found, fields) => {
    expect(webhookDivergences(found, expected)).toEqual(fields);
  });

  it('headers ausentes, chave esperada ausente: não diverge; presente na resposta: diverge', () => {
    const noKey: ExpectedWebhook = { url: expected.url, apikey: undefined };
    const { headers: _drop, ...noHeaders } = flat;
    void _drop;
    expect(webhookDivergences(noHeaders, noKey)).toEqual([]);
    expect(webhookDivergences(flat, noKey)).toEqual(['headers.apikey']);
    expect(webhookDivergences(noHeaders, expected)).toEqual(['headers.apikey']);
  });
});

describe('buildWebhookSetBody', () => {
  it('buildWebhookSetBody usa byEvents/base64 e omite headers sem apikey', () => {
    const body = buildWebhookSetBody(expected);
    expect(body).toEqual({
      webhook: {
        enabled: true,
        url: expected.url,
        headers: { apikey: 'GLOBAL-KEY' },
        byEvents: false,
        base64: false,
        events,
      },
    });
    const semChave = buildWebhookSetBody({
      url: expected.url,
      apikey: undefined,
    });
    expect(semChave.webhook).not.toHaveProperty('headers');
    expect(semChave.webhook).toMatchObject({ byEvents: false, base64: false });
  });
});
