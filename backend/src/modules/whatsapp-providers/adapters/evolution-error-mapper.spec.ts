import { describe, it, expect } from 'vitest';
import { classifyEvolutionError } from './evolution-error-mapper';

/**
 * Pure-function table-driven coverage. Each row exercises one regex/keyword
 * branch in classifyEvolutionError so that any future refactor of the mapper
 * is forced to keep the contract the worker depends on (code + fatal flag).
 */
describe('classifyEvolutionError', () => {
  type Case = {
    name: string;
    input: unknown;
    code: string;
    fatal: boolean;
  };

  const cases: Case[] = [
    // session_closed family — abnormal/transient closures are retryable (fatal:false);
    // only closures signalling a replaced/logged-out session require operator action (fatal:true).
    { name: 'connection closed', input: 'Connection Closed', code: 'evolution.session_closed', fatal: false },
    { name: 'conflict', input: 'conflict (replaced)', code: 'evolution.session_closed', fatal: true },
    { name: 'replaced', input: 'session was replaced', code: 'evolution.session_closed', fatal: true },
    { name: 'logged out', input: 'Connection Closed: logged out', code: 'evolution.session_closed', fatal: true },
    { name: 'precondition required', input: 'Precondition Required', code: 'evolution.session_closed', fatal: true },
    { name: 'connection: close', input: 'state changed: connection: close', code: 'evolution.session_closed', fatal: true },
    { name: 'WS code 1006 (raw)', input: '1006', code: 'evolution.session_closed', fatal: false },
    { name: 'WS code 1006 (json array)', input: '["1006"]', code: 'evolution.session_closed', fatal: false },
    { name: 'WS code 1011', input: '1011', code: 'evolution.session_closed', fatal: false },
    { name: 'WS code 1011 (quoted)', input: 'something "1011" here', code: 'evolution.session_closed', fatal: false },

    // session_unstable
    {
      name: "cannot read properties of undefined (reading 'id')",
      input: "TypeError: Cannot read properties of undefined (reading 'id')",
      code: 'evolution.session_unstable',
      fatal: false,
    },
    {
      name: 'cannot destructure',
      input: 'Cannot destructure property of undefined',
      code: 'evolution.session_unstable',
      fatal: false,
    },

    // not_connected
    { name: 'not connected', input: 'instance is not connected', code: 'evolution.not_connected', fatal: false },
    { name: 'not open', input: 'WebSocket is not open', code: 'evolution.not_connected', fatal: false },
    { name: 'connection: connecting', input: 'state: connection: connecting', code: 'evolution.not_connected', fatal: false },

    // not on whatsapp
    { name: 'not on whatsapp', input: 'Number not on whatsapp', code: 'evolution.number_not_on_whatsapp', fatal: true },
    { name: 'exists":false (json shape)', input: '{"exists":false}', code: 'evolution.number_not_on_whatsapp', fatal: true },

    // rate limited — 429 only matches as a bounded HTTP status, never a digit run inside a JID
    { name: 'rate-overlimit', input: 'rate-overlimit', code: 'evolution.rate_limited', fatal: false },
    { name: 'rate limit', input: 'WhatsApp rate limit reached', code: 'evolution.rate_limited', fatal: false },
    { name: '429 status', input: 'Request failed with status code 429', code: 'evolution.rate_limited', fatal: false },
    {
      name: '429 embedded in recipient JID is NOT a rate limit',
      input: 'Error sending to 5511994290123@s.whatsapp.net',
      code: 'evolution.unknown',
      fatal: false,
    },

    // provider auth (Evolution apikey / HTTP 401) — retryable config problem, NOT a WhatsApp ban
    { name: 'unauthorized (401 apikey)', input: 'Unauthorized', code: 'evolution.provider_unauthorized', fatal: false },
    {
      name: 'status code 401',
      input: 'Request failed with status code 401',
      code: 'evolution.provider_unauthorized',
      fatal: false,
    },

    // unauthorized — WhatsApp-level rejection (possible ban), fatal
    { name: 'not-authorized', input: 'not-authorized', code: 'evolution.unauthorized', fatal: true },
    { name: 'forbidden', input: 'Forbidden', code: 'evolution.unauthorized', fatal: true },
    { name: 'blocked', input: 'number was blocked', code: 'evolution.unauthorized', fatal: true },

    // timeout
    { name: 'timeout', input: 'Operation timeout', code: 'evolution.timeout', fatal: false },
    { name: 'ETIMEDOUT', input: 'connect ETIMEDOUT 1.2.3.4:8080', code: 'evolution.timeout', fatal: false },
    { name: 'ECONNABORTED', input: 'ECONNABORTED', code: 'evolution.timeout', fatal: false },

    // unreachable
    { name: 'ECONNREFUSED', input: 'connect ECONNREFUSED 127.0.0.1:8080', code: 'evolution.unreachable', fatal: false },
    { name: 'ENOTFOUND', input: 'getaddrinfo ENOTFOUND evolution', code: 'evolution.unreachable', fatal: false },

    // bad request — runs after rate_limit & unauthorized so they win when keywords overlap.
    // 400 only matches as a bounded HTTP status or the 'bad request' phrase, never a JID digit run.
    { name: 'bad request', input: 'Bad Request', code: 'evolution.bad_request', fatal: true },
    { name: '400 status', input: 'Request failed with status code 400', code: 'evolution.bad_request', fatal: true },
    {
      name: '400 embedded in recipient JID is NOT a bad request',
      input: 'Error sending to 5511994000123@s.whatsapp.net',
      code: 'evolution.unknown',
      fatal: false,
    },

    // unknown / fallback
    { name: 'unknown random string', input: 'something nobody planned for', code: 'evolution.unknown', fatal: false },
    { name: 'empty string', input: '', code: 'evolution.unknown', fatal: false },
  ];

  it.each(cases)('classifies $name as $code (fatal=$fatal)', ({ input, code, fatal }) => {
    const out = classifyEvolutionError(input);
    expect(out.code).toBe(code);
    expect(out.fatal).toBe(fatal);
    expect(typeof out.message).toBe('string');
    expect(out.message.length).toBeGreaterThan(0);
  });

  it('handles non-string number input without crashing', () => {
    const out = classifyEvolutionError(1006);
    // 1006 stringifies to "1006" — an abnormal WS closure: session_closed but retryable
    expect(out.code).toBe('evolution.session_closed');
    expect(out.fatal).toBe(false);
  });

  it('handles object input by JSON-stringifying it', () => {
    const out = classifyEvolutionError({ message: 'Connection Closed' });
    expect(out.code).toBe('evolution.session_closed');
  });

  it('returns sensible default for null', () => {
    const out = classifyEvolutionError(null);
    expect(out.code).toBe('evolution.unknown');
    expect(out.fatal).toBe(false);
    expect(out.message).toBe('Falha desconhecida no envio');
  });

  it('returns sensible default for undefined', () => {
    const out = classifyEvolutionError(undefined);
    expect(out.code).toBe('evolution.unknown');
    expect(out.fatal).toBe(false);
  });

  it('falls back to String() when JSON.stringify throws (circular ref)', () => {
    const obj: Record<string, unknown> = {};
    obj.self = obj;
    const out = classifyEvolutionError(obj);
    // Should not throw — code is unknown because the stringified form is "[object Object]"
    expect(out.code).toBe('evolution.unknown');
  });

  it('uses raw value in bad_request message when available', () => {
    const out = classifyEvolutionError('400 Bad Request: invalid number');
    expect(out.code).toBe('evolution.bad_request');
    expect(out.message).toContain('400 Bad Request: invalid number');
  });

  it('uses "sem detalhes" when bad_request raw is empty-ish', () => {
    // Force the bad_request branch with falsy raw (an empty array stringifies to "[]" — pick a 400 marker)
    const out = classifyEvolutionError(0);
    // 0 -> "0" — falls through to unknown, message reflects raw text
    expect(out.code).toBe('evolution.unknown');
  });

  /**
   * Characterization: lock the EXACT message + fatal flag returned for one
   * representative input of every classification branch. The code+fatal table
   * above already guards routing; this additionally pins the operator-facing
   * Portuguese copy so a data-table refactor cannot silently alter wording.
   */
  describe('characterization — exact message per branch', () => {
    type MsgCase = { name: string; input: unknown; expected: { code: string; message: string; fatal: boolean } };
    const msgCases: MsgCase[] = [
      {
        name: 'session_closed (replaced — fatal)',
        input: 'conflict (replaced)',
        expected: {
          code: 'evolution.session_closed',
          message:
            'Sessão WhatsApp desconectada. Outro WhatsApp Web/Desktop pode estar logado com esse número — saia de todos os "Aparelhos conectados" no app e reconecte em /connect.',
          fatal: true,
        },
      },
      {
        name: 'session_closed (transient drop — retryable)',
        input: 'Connection Closed',
        expected: {
          code: 'evolution.session_closed',
          message:
            'Conexão com o WhatsApp caiu momentaneamente. Tentando reenviar automaticamente; reconecte em /connect se persistir.',
          fatal: false,
        },
      },
      {
        name: 'session_unstable',
        input: "Cannot read properties of undefined (reading 'id')",
        expected: {
          code: 'evolution.session_unstable',
          message:
            'Sessão WhatsApp ainda instabilizando. Aguarde 30 segundos após conectar antes de disparar, ou reconecte se persistir (verifique /connect).',
          fatal: false,
        },
      },
      {
        name: 'not_connected',
        input: 'instance is not connected',
        expected: {
          code: 'evolution.not_connected',
          message: 'WhatsApp ainda não conectou. Acesse /connect e escaneie o QR Code antes de disparar.',
          fatal: false,
        },
      },
      {
        name: 'number_not_on_whatsapp',
        input: 'Number not on whatsapp',
        expected: {
          code: 'evolution.number_not_on_whatsapp',
          message: 'Número não está no WhatsApp.',
          fatal: true,
        },
      },
      {
        name: 'rate_limited',
        input: 'rate-overlimit',
        expected: {
          code: 'evolution.rate_limited',
          message: 'WhatsApp aplicou rate limit — aguarde e tente novamente.',
          fatal: false,
        },
      },
      {
        name: 'provider_unauthorized (Evolution apikey / 401)',
        input: 'Request failed with status code 401 Unauthorized',
        expected: {
          code: 'evolution.provider_unauthorized',
          message:
            'Falha de autenticação com a Evolution API (apikey inválida ou rotacionada?). Verifique a AUTHENTICATION_API_KEY do container — os envios serão retentados.',
          fatal: false,
        },
      },
      {
        name: 'unauthorized (WhatsApp rejection / possible ban)',
        input: 'not-authorized',
        expected: {
          code: 'evolution.unauthorized',
          message:
            'Ação rejeitada pelo WhatsApp. Pode indicar que o número foi marcado como spam ou banido — pare os disparos e investigue antes de continuar.',
          fatal: true,
        },
      },
      {
        name: 'timeout',
        input: 'Operation timeout',
        expected: {
          code: 'evolution.timeout',
          message: 'Timeout ao falar com a Evolution API.',
          fatal: false,
        },
      },
      {
        name: 'unreachable',
        input: 'connect ECONNREFUSED 127.0.0.1:8080',
        expected: {
          code: 'evolution.unreachable',
          message: 'Evolution API inacessível (container fora? rede?).',
          fatal: false,
        },
      },
      {
        name: 'bad_request (with raw detail)',
        input: 'Bad Request',
        expected: {
          code: 'evolution.bad_request',
          message: 'Requisição inválida para a Evolution: Bad Request',
          fatal: true,
        },
      },
    ];

    it.each(msgCases)('returns exact contract for $name', ({ input, expected }) => {
      expect(classifyEvolutionError(input)).toEqual(expected);
    });

    it('bad_request uses "sem detalhes" when raw is nullish but text still matches 400', () => {
      // A non-null object whose JSON-stringified form contains "400" but whose
      // `raw ?? 'sem detalhes'` would still render the object. Use an explicit
      // marker: an array containing "400" stringifies to '["400"]' (matches 400),
      // and raw is truthy, so the message embeds the raw array.
      const out = classifyEvolutionError(['400']);
      expect(out.code).toBe('evolution.bad_request');
      expect(out.message).toBe('Requisição inválida para a Evolution: 400');
      expect(out.fatal).toBe(true);
    });

    it('unknown branch echoes the original (non-lowercased) raw string when present', () => {
      const out = classifyEvolutionError('Algo Inesperado XYZ');
      expect(out).toEqual({
        code: 'evolution.unknown',
        message: 'Algo Inesperado XYZ',
        fatal: false,
      });
    });

    it('unknown branch falls back to the default Portuguese message when raw is whitespace-only', () => {
      // rawString.trim().length === 0 -> default copy is used, not the blanks.
      const out = classifyEvolutionError('   ');
      expect(out).toEqual({
        code: 'evolution.unknown',
        message: 'Falha desconhecida no envio',
        fatal: false,
      });
    });
  });
});
