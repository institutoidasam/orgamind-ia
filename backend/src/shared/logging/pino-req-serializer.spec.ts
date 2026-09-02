import { describe, it, expect } from 'vitest';
import { sanitizeReqForLog } from './pino-req-serializer';

/**
 * O CORAÇÃO DO VAZAMENTO. O serializer padrão do pino-std-serializers copia
 * `req.url = req.originalUrl` — que no Express carrega a query string INTEIRA
 * — e expõe `req.query` como objeto à parte. `autoLogging` do pino-http está
 * ligado por padrão, então TODA resposta (200 e 401) grava esse req no log.
 * O `t=<segredo>` do GoZap (e o `hub.verify_token` da Meta) é o ÚNICO segredo
 * que protege essas rotas — se ele aparece no log de produção, quem lê log
 * pode forjar webhooks.
 *
 * `redact` do pino é por CAMINHO (dot-path), não por substring: redigir
 * `req.query.t` não bastaria, porque o segredo continuaria dentro da STRING
 * de `req.url`. Por isso o teste verifica o objeto SERIALIZADO por inteiro,
 * não só uma chave.
 */
describe('sanitizeReqForLog', () => {
  const SECRET = 'segredo-super-secreto-t9x2';

  it('remove a query string de req.url (mantém só o pathname)', () => {
    const req = {
      method: 'POST',
      url: `/webhooks/gozap?t=${SECRET}`,
      query: { t: SECRET },
      headers: { 'user-agent': 'gozap' },
    };

    const result = sanitizeReqForLog(req);

    expect(result.url).toBe('/webhooks/gozap');
  });

  it('remove req.query por completo', () => {
    const req = {
      method: 'POST',
      url: `/webhooks/gozap?t=${SECRET}`,
      query: { t: SECRET },
      headers: {},
    };

    const result = sanitizeReqForLog(req);

    expect(result.query).toBeUndefined();
  });

  it('o objeto inteiro, serializado, não contém o segredo em NENHUM campo', () => {
    const req = {
      method: 'POST',
      url: `/webhooks/gozap?t=${SECRET}`,
      query: { t: SECRET },
      params: {},
      headers: { 'user-agent': 'gozap' },
      remoteAddress: '127.0.0.1',
    };

    const result = sanitizeReqForLog(req);

    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it('o handshake da Meta (hub.verify_token na query) também some do log', () => {
    const req = {
      method: 'GET',
      url: `/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${SECRET}&hub.challenge=abc`,
      query: { 'hub.mode': 'subscribe', 'hub.verify_token': SECRET, 'hub.challenge': 'abc' },
      headers: {},
    };

    const result = sanitizeReqForLog(req);

    expect(result.url).toBe('/webhooks/whatsapp');
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it('preserva method e headers — o diagnóstico não pode degradar, só a query sai', () => {
    const req = {
      method: 'POST',
      url: `/webhooks/gozap?t=${SECRET}`,
      query: { t: SECRET },
      headers: { 'user-agent': 'gozap', 'x-request-id': 'req-1' },
      remoteAddress: '203.0.113.9',
    };

    const result = sanitizeReqForLog(req);

    expect(result.method).toBe('POST');
    expect(result.headers).toEqual({ 'user-agent': 'gozap', 'x-request-id': 'req-1' });
    expect(result.remoteAddress).toBe('203.0.113.9');
  });

  it('url sem query string permanece intocada', () => {
    const req = { method: 'GET', url: '/healthz', headers: {} };

    const result = sanitizeReqForLog(req);

    expect(result.url).toBe('/healthz');
  });
});
