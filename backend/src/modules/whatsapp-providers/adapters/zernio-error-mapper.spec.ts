import { describe, it, expect } from 'vitest';

import {
  classifyZernioError,
  isZernioOptOutCode,
} from './zernio-error-mapper';

describe('classifyZernioError', () => {
  it('marks an invalid recipient (Meta 131021) as fatal', () => {
    const c = classifyZernioError('131021');
    expect(c.fatal).toBe(true);
    expect(c.optedOut).toBe(false);
    expect(c.code).toBe('131021');
  });

  it('marks a missing/unapproved template (Meta 132001) as fatal', () => {
    expect(classifyZernioError('132001').fatal).toBe(true);
  });

  it('marks a template param mismatch (Meta 132000) as fatal', () => {
    expect(classifyZernioError('132000').fatal).toBe(true);
  });

  it('marks a disconnected account (linked_account_required) as fatal', () => {
    expect(classifyZernioError('linked_account_required').fatal).toBe(true);
    expect(classifyZernioError('account_not_found').fatal).toBe(true);
  });

  it('marks a suspended/blocked number (Meta 131031) as fatal', () => {
    expect(classifyZernioError('131031').fatal).toBe(true);
  });

  it('marks a paused/disabled template (Meta 132015/132016) as fatal', () => {
    expect(classifyZernioError('132015').fatal).toBe(true);
    expect(classifyZernioError('132016').fatal).toBe(true);
  });

  // C2 (spec §5.3): a WABA do Zernio é da própria Meta — mesmos códigos. O cap
  // de marketing por destinatário (131049) é fatal NAQUELA mensagem e o reenvio
  // antes de 24h é proibido (retentar PIORA: a Meta pode bloquear a entrega ao
  // usuário por mais 24h).
  it('marks the per-user marketing cap (Meta 131049) as fatal, without opting the contact out', () => {
    const c = classifyZernioError('131049');
    expect(c.fatal).toBe(true);
    expect(c.optedOut).toBe(false);
    expect(c.message.toLowerCase()).toContain('marketing');
    expect(c.message).toContain('24h');
  });

  it('marks out-of-24h-window re-engagement (Meta 131047) as fatal, not transient', () => {
    // A free-form retry never succeeds outside the window — only a template does.
    expect(classifyZernioError('131047').fatal).toBe(true);
  });

  // ZE — MARKETING DESLIGADO PELO DESTINATÁRIO (medido ao vivo: num broadcast
  // real de 120 destinatários, 37 falharam — 30% da base — sendo 36x 131026 e
  // 1x 130472). São falhas do DESTINATÁRIO e são DEFINITIVAS para MARKETING:
  // reenviar não entrega e só queima cota do tier.
  it('marca 131026 (marketing desligado) como fatal', () => {
    const c = classifyZernioError('131026');
    expect(c.fatal).toBe(true);
  });

  it('marca 130472 (experimento de marketing da Meta) como FATAL — NÃO retentar', () => {
    // Antes desta regra o 130472 caía no default (retryable) e queimava as 5
    // tentativas do BullMQ contra uma parede: a Meta não entrega template de
    // MARKETING a este usuário, ponto. UTILITY continua funcionando — e a
    // mensagem precisa dizer isso, senão o operador não sabe a saída.
    const c = classifyZernioError('130472');
    expect(c.fatal).toBe(true);
    expect(c.optedOut).toBe(false);
    expect(c.code).toBe('130472');
    expect(c.message.toUpperCase()).toContain('MARKETING');
    expect(c.message.toUpperCase()).toContain('UTILITY');
  });

  // ── 401/403: NÃO retentáveis ──────────────────────────────────────────────
  // A chave do orgamind é de um usuário CONVIDADO na workspace Zernio do cliente, e
  // `POST /inbox/conversations` responde 403 "Inbox addon required or profile
  // limit reached". Se o dono cancelar o add-on / revogar a chave / entrar em
  // suspensão, TODO envio passa a dar 401/403 — e o default do mapper é
  // retryable. Resultado: retry infinito queimando o balde de 60 req/min (o teto
  // real da conta hoje) e travando a fila inteira. Nenhum retry conserta uma
  // chave revogada ou um add-on cancelado: é fatal, e o operador precisa saber.
  it('marca 401 (chave inválida/revogada) como FATAL — nunca retentar', () => {
    const c = classifyZernioError('401');
    expect(c.fatal).toBe(true);
    expect(c.optedOut).toBe(false);
  });

  it('marca 403 (add-on de inbox cancelado / limite de perfil) como FATAL', () => {
    const c = classifyZernioError('403');
    expect(c.fatal).toBe(true);
    expect(c.optedOut).toBe(false);
    // O 403 real da Zernio é entitlement, não permissão de rota — a mensagem
    // tem que mandar o operador olhar a assinatura/add-on da workspace.
    expect(c.message.toLowerCase()).toMatch(/add-on|assinatura|plano/);
  });

  it('marca o type authentication_error como FATAL (era retryable)', () => {
    expect(classifyZernioError(undefined, 'authentication_error').fatal).toBe(
      true,
    );
  });

  it('mantém permission_error fatal', () => {
    expect(classifyZernioError(undefined, 'permission_error').fatal).toBe(true);
  });

  it('keeps rate limiting transient — by Zernio code, HTTP 429, and type', () => {
    expect(classifyZernioError('rate_limited').fatal).toBe(false);
    expect(classifyZernioError('429').fatal).toBe(false);
    expect(classifyZernioError(undefined, 'rate_limit_error').fatal).toBe(false);
  });

  it('keeps server/api errors and network timeouts transient', () => {
    expect(classifyZernioError('internal_error').fatal).toBe(false);
    expect(classifyZernioError(undefined, 'api_error').fatal).toBe(false);
    expect(classifyZernioError('zernio.timeout').fatal).toBe(false);
    expect(classifyZernioError('zernio.unreachable').fatal).toBe(false);
  });

  it('defaults an unknown code to non-fatal (retryable) and keeps the raw message', () => {
    const c = classifyZernioError('brand_new_code', undefined, 'kaboom');
    expect(c.fatal).toBe(false);
    expect(c.optedOut).toBe(false);
    expect(c.code).toBe('brand_new_code');
    expect(c.message).toBe('kaboom');
  });

  it('flags an opt-out code as fatal + optedOut', () => {
    const c = classifyZernioError('131050');
    expect(c.fatal).toBe(true);
    expect(c.optedOut).toBe(true);
  });
});

describe('isZernioOptOutCode', () => {
  it('is true for opt-out codes only', () => {
    expect(isZernioOptOutCode('131050')).toBe(true);
    expect(isZernioOptOutCode('recipient_opted_out')).toBe(true);
  });

  it('is false for fatal-but-not-opt-out and for unknown/undefined', () => {
    expect(isZernioOptOutCode('131021')).toBe(false);
    expect(isZernioOptOutCode('nope')).toBe(false);
    expect(isZernioOptOutCode(undefined)).toBe(false);
  });
});
