// Characterization tests for the pure helpers extracted from the
// `TemplateFormDialog` `onSubmit` handler. These lock the *current* behaviour
// (payload shape per kind, interactive-config parsing, and submit-error
// mapping) so the complexity refactor can be proven behaviour-identical.
import { describe, it, expect } from 'vitest';
import { HTTPError } from 'ky';
import {
  parseInteractiveConfig,
  buildTemplatePayload,
  mapTemplateSubmitError,
} from './template-form-dialog';
import type { z } from 'zod';
import type { createTemplateSchema } from '../schemas';

type FormValues = z.input<typeof createTemplateSchema>;

function makeKyError(status: number, body: unknown): HTTPError {
  const isString = typeof body === 'string';
  const response = new Response(isString ? (body as string) : JSON.stringify(body), {
    status,
    headers: {
      'content-type': isString ? 'text/plain' : 'application/json',
    },
  });
  return new HTTPError(
    response as never,
    new Request('http://localhost/templates') as never,
    {} as never,
  );
}

describe('parseInteractiveConfig', () => {
  it('returns null config for TEXT without parsing (ignores configText)', () => {
    expect(parseInteractiveConfig('TEXT', 'not json at all')).toEqual({
      ok: true,
      config: null,
    });
  });

  it('parses valid JSON for interactive kinds', () => {
    const json = '{"question":"x","options":["a","b"]}';
    expect(parseInteractiveConfig('POLL', json)).toEqual({
      ok: true,
      config: { question: 'x', options: ['a', 'b'] },
    });
  });

  it('parses LIST and BUTTONS config objects', () => {
    expect(parseInteractiveConfig('LIST', '{"sections":[]}')).toEqual({
      ok: true,
      config: { sections: [] },
    });
    expect(parseInteractiveConfig('BUTTONS', '{"buttons":[]}')).toEqual({
      ok: true,
      config: { buttons: [] },
    });
  });

  it('reports a parse error with the JS error message for invalid JSON', () => {
    const result = parseInteractiveConfig('LIST', '{ invalid');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(typeof result.message).toBe('string');
      expect(result.message.length).toBeGreaterThan(0);
    }
  });

  it('reports a parse error for empty text on an interactive kind', () => {
    const result = parseInteractiveConfig('BUTTONS', '');
    expect(result.ok).toBe(false);
  });
});

describe('buildTemplatePayload', () => {
  const baseValues: FormValues = {
    metaName: 'boas_vindas',
    language: 'pt_BR',
    body: 'Olá {{1}}',
    category: 'UTILITY',
    kind: 'TEXT',
    interactiveConfig: null,
    provider: 'EVOLUTION',
  };

  describe('create mode', () => {
    it('builds a TEXT create payload with body and null interactiveConfig', () => {
      const out = buildTemplatePayload({
        mode: 'create',
        kind: 'TEXT',
        values: baseValues,
        interactiveConfig: null,
      });
      expect(out).toEqual({
        mode: 'create',
        input: {
          metaName: 'boas_vindas',
          language: 'pt_BR',
          category: 'UTILITY',
          body: 'Olá {{1}}',
          kind: 'TEXT',
          interactiveConfig: null,
          provider: 'EVOLUTION',
        },
      });
    });

    it('forces empty body and passes parsed config for interactive create (LIST/BUTTONS/POLL)', () => {
      const config = { sections: [] };
      for (const kind of ['LIST', 'BUTTONS', 'POLL'] as const) {
        const out = buildTemplatePayload({
          mode: 'create',
          kind,
          values: { ...baseValues, kind, body: 'should be ignored' },
          interactiveConfig: config,
        });
        expect(out).toEqual({
          mode: 'create',
          input: {
            metaName: 'boas_vindas',
            language: 'pt_BR',
            category: 'UTILITY',
            body: '',
            kind,
            interactiveConfig: config,
            provider: 'EVOLUTION',
          },
        });
      }
    });

    it('includes the selected provider in the create payload', () => {
      const out = buildTemplatePayload({
        mode: 'create',
        kind: 'TEXT',
        values: { ...baseValues, provider: 'TWILIO', twilioContentSid: 'HX0123456789abcdef0123456789abcdef' },
        interactiveConfig: null,
      });
      if (out.mode === 'create') {
        expect(out.input.provider).toBe('TWILIO');
      }
    });

    it('defaults provider to EVOLUTION when the form value is undefined', () => {
      const out = buildTemplatePayload({
        mode: 'create',
        kind: 'TEXT',
        values: { ...baseValues, provider: undefined },
        interactiveConfig: null,
      });
      if (out.mode === 'create') {
        expect(out.input.provider).toBe('EVOLUTION');
      }
    });

    it('includes twilioContentSid in the create payload when set', () => {
      const HX = 'HX0123456789abcdef0123456789abcdef';
      const out = buildTemplatePayload({
        mode: 'create',
        kind: 'TEXT',
        values: { ...baseValues, twilioContentSid: HX },
        interactiveConfig: null,
      });
      if (out.mode === 'create') {
        expect(out.input.twilioContentSid).toBe(HX);
      }
    });

    it('omits twilioContentSid from the create payload when empty', () => {
      const out = buildTemplatePayload({
        mode: 'create',
        kind: 'TEXT',
        values: { ...baseValues, twilioContentSid: '' },
        interactiveConfig: null,
      });
      if (out.mode === 'create') {
        expect('twilioContentSid' in out.input).toBe(false);
      }
    });

    it('applies pt_BR/UTILITY fallbacks when language/category are undefined', () => {
      const out = buildTemplatePayload({
        mode: 'create',
        kind: 'TEXT',
        values: {
          metaName: 'x',
          language: undefined,
          body: undefined,
          category: undefined,
          kind: 'TEXT',
          interactiveConfig: null,
          provider: 'EVOLUTION',
        },
        interactiveConfig: null,
      });
      expect(out).toEqual({
        mode: 'create',
        input: {
          metaName: 'x',
          language: 'pt_BR',
          category: 'UTILITY',
          body: '',
          kind: 'TEXT',
          interactiveConfig: null,
          provider: 'EVOLUTION',
        },
      });
    });
  });

  describe('edit mode', () => {
    it('builds a TEXT edit payload that includes body, null interactiveConfig, provider and a null twilioContentSid', () => {
      const out = buildTemplatePayload({
        mode: 'edit',
        id: 'tpl-1',
        kind: 'TEXT',
        values: { ...baseValues, body: 'novo corpo' },
        interactiveConfig: null,
      });
      expect(out).toEqual({
        mode: 'edit',
        id: 'tpl-1',
        input: {
          language: 'pt_BR',
          body: 'novo corpo',
          category: 'UTILITY',
          kind: 'TEXT',
          interactiveConfig: null,
          provider: 'EVOLUTION',
          twilioContentSid: null,
        },
      });
    });

    it('omits body and passes parsed config for interactive edit (LIST/BUTTONS/POLL)', () => {
      const config = { buttons: [{ buttonId: 'yes', title: 'Sim' }] };
      for (const kind of ['LIST', 'BUTTONS', 'POLL'] as const) {
        const out = buildTemplatePayload({
          mode: 'edit',
          id: 'tpl-9',
          kind,
          values: { ...baseValues, kind, body: 'ignored' },
          interactiveConfig: config,
        });
        expect(out).toEqual({
          mode: 'edit',
          id: 'tpl-9',
          input: {
            language: 'pt_BR',
            category: 'UTILITY',
            kind,
            interactiveConfig: config,
            provider: 'EVOLUTION',
            twilioContentSid: null,
          },
        });
        // explicitly assert body key is absent for interactive edit
        if (out.mode === 'edit') {
          expect('body' in out.input).toBe(false);
        }
      }
    });

    it('includes the selected provider in the edit payload', () => {
      const out = buildTemplatePayload({
        mode: 'edit',
        id: 'tpl-8',
        kind: 'TEXT',
        values: { ...baseValues, provider: 'TWILIO' },
        interactiveConfig: null,
      });
      if (out.mode === 'edit') {
        expect(out.input.provider).toBe('TWILIO');
      }
    });

    it('includes twilioContentSid in the edit payload when set', () => {
      const HX = 'HX0123456789abcdef0123456789abcdef';
      const out = buildTemplatePayload({
        mode: 'edit',
        id: 'tpl-7',
        kind: 'TEXT',
        values: { ...baseValues, twilioContentSid: HX },
        interactiveConfig: null,
      });
      if (out.mode === 'edit') {
        expect(out.input.twilioContentSid).toBe(HX);
      }
    });

    it('sends an explicit null (never omits) twilioContentSid on edit when empty — clearing it server-side rather than leaving a stale value', () => {
      const out = buildTemplatePayload({
        mode: 'edit',
        id: 'tpl-10',
        kind: 'TEXT',
        values: { ...baseValues, twilioContentSid: '' },
        interactiveConfig: null,
      });
      if (out.mode === 'edit') {
        expect('twilioContentSid' in out.input).toBe(true);
        expect(out.input.twilioContentSid).toBeNull();
      }
    });

    it('defaults TEXT edit body to empty string when value is undefined', () => {
      const out = buildTemplatePayload({
        mode: 'edit',
        id: 'tpl-2',
        kind: 'TEXT',
        values: { ...baseValues, body: undefined },
        interactiveConfig: null,
      });
      if (out.mode === 'edit') {
        expect(out.input.body).toBe('');
      }
    });
  });
});

describe('mapTemplateSubmitError', () => {
  it('maps template.meta_name_conflict to a metaName field error + toast', async () => {
    const err = makeKyError(409, { code: 'template.meta_name_conflict' });
    const out = await mapTemplateSubmitError(err);
    expect(out).toEqual({
      kind: 'metaNameConflict',
      field: 'metaName',
      fieldMessage: 'metaName já existe',
      toast: 'Já existe um template com esse metaName',
    });
  });

  it('maps template.interactive_config_invalid to a config error using detail', async () => {
    const err = makeKyError(400, {
      code: 'template.interactive_config_invalid',
      detail: 'sections must not be empty',
    });
    const out = await mapTemplateSubmitError(err);
    expect(out).toEqual({
      kind: 'interactiveInvalid',
      configError: 'sections must not be empty',
      toast: 'Configuração interativa inválida',
    });
  });

  it('maps template.interactive_config_required to a config error', async () => {
    const err = makeKyError(400, {
      code: 'template.interactive_config_required',
    });
    const out = await mapTemplateSubmitError(err);
    expect(out).toEqual({
      kind: 'interactiveInvalid',
      configError: 'Configuração inválida',
      toast: 'Configuração interativa inválida',
    });
  });

  it('falls back to the default config error message when detail is absent', async () => {
    const err = makeKyError(400, {
      code: 'template.interactive_config_invalid',
    });
    const out = await mapTemplateSubmitError(err);
    if (out.kind === 'interactiveInvalid') {
      expect(out.configError).toBe('Configuração inválida');
    }
  });

  it('maps template.twilio_content_sid_required to a twilioContentSid field error + toast', async () => {
    const err = makeKyError(400, {
      code: 'template.twilio_content_sid_required',
      detail: 'Templates do provedor TWILIO exigem o campo twilioContentSid (Content SID aprovado).',
    });
    const out = await mapTemplateSubmitError(err);
    expect(out).toEqual({
      kind: 'providerTwilioMismatch',
      field: 'twilioContentSid',
      fieldMessage:
        'Templates do provedor TWILIO exigem o campo twilioContentSid (Content SID aprovado).',
      toast: 'Provedor e Content SID inconsistentes',
    });
  });

  it('maps template.twilio_content_sid_not_allowed to a twilioContentSid field error + toast', async () => {
    const err = makeKyError(400, {
      code: 'template.twilio_content_sid_not_allowed',
    });
    const out = await mapTemplateSubmitError(err);
    expect(out).toEqual({
      kind: 'providerTwilioMismatch',
      field: 'twilioContentSid',
      fieldMessage: 'Content SID inconsistente com o provedor selecionado',
      toast: 'Provedor e Content SID inconsistentes',
    });
  });

  it('maps HTTP 403 to the admin-only toast', async () => {
    const err = makeKyError(403, { code: 'forbidden' });
    const out = await mapTemplateSubmitError(err);
    expect(out).toEqual({
      kind: 'forbidden',
      toast: 'Apenas administradores podem alterar templates',
    });
  });

  it('maps HTTP 500 to the server-error toast', async () => {
    const err = makeKyError(500, { code: 'oops' });
    const out = await mapTemplateSubmitError(err);
    expect(out).toEqual({
      kind: 'serverError',
      toast: 'Erro do servidor. Tente novamente.',
    });
  });

  it('maps HTTP 503 (>=500) to the server-error toast', async () => {
    const err = makeKyError(503, 'Service Unavailable');
    const out = await mapTemplateSubmitError(err);
    expect(out.kind).toBe('serverError');
  });

  it('maps an unknown HTTP error (e.g. 400 without recognised code) to the generic toast', async () => {
    const err = makeKyError(400, { code: 'something_else' });
    const out = await mapTemplateSubmitError(err);
    expect(out).toEqual({
      kind: 'generic',
      toast: 'Falha ao salvar template',
    });
  });

  it('maps a 4xx with an unparseable JSON body to the generic toast', async () => {
    const err = makeKyError(422, 'not json');
    const out = await mapTemplateSubmitError(err);
    expect(out.kind).toBe('generic');
    expect(out.toast).toBe('Falha ao salvar template');
  });

  it('maps a non-HTTP error to the network toast', async () => {
    const out = await mapTemplateSubmitError(new Error('boom'));
    expect(out).toEqual({ kind: 'network', toast: 'Erro de rede' });
  });

  it('maps a non-Error thrown value to the network toast', async () => {
    const out = await mapTemplateSubmitError('string thrown');
    expect(out).toEqual({ kind: 'network', toast: 'Erro de rede' });
  });
});

/**
 * ZB — o backend passou a recusar provider=ZERNIO neste endpoint (a row nasceria
 * "aprovada" sem existir na Meta). Sem este mapeamento o 400 caía no ramo
 * genérico: toast "Falha ao salvar template", sem campo em erro e sem uma pista
 * de que existe o botão "Novo template Zernio" ao lado — um fluxo que falha mudo.
 */
describe('mapTemplateSubmitError — ZERNIO', () => {
  it('aponta o caminho certo quando o backend recusa provider=ZERNIO', async () => {
    const err = makeKyError(400, {
      code: 'template.zernio_requires_remote_create',
    });
    const out = await mapTemplateSubmitError(err);
    expect(out.kind).toBe('zernioRequiresRemoteCreate');
    expect(out.toast).toContain('Novo template Zernio');
    if (out.kind === 'zernioRequiresRemoteCreate') {
      expect(out.field).toBe('provider');
    }
  });

  it('não deixa o operador forjar APPROVED numa row ZERNIO por edição', async () => {
    const err = makeKyError(400, {
      code: 'template.zernio_status_not_editable',
      detail: 'status=PENDING → APPROVED',
    });
    const out = await mapTemplateSubmitError(err);
    expect(out.kind).toBe('zernioRequiresRemoteCreate');
    expect(out.toast).toContain('Meta');
  });
});
