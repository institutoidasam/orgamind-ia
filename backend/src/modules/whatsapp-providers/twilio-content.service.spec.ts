import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { ConfigService } from '@nestjs/config';
import { TwilioContentService } from './twilio-content.service';
import { DomainError } from '../../shared/errors/domain.error';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const ACCOUNT_SID = 'AC00000000000000000000000000000000';
const AUTH_TOKEN = 'the-auth-token';
const BASE = 'https://content.twilio.com';
const LIST_URL = `${BASE}/v1/ContentAndApprovals`;

function makeConfig(overrides: Record<string, string | undefined> = {}) {
  const values: Record<string, string | undefined> = {
    TWILIO_ACCOUNT_SID: ACCOUNT_SID,
    TWILIO_AUTH_TOKEN: AUTH_TOKEN,
    ...overrides,
  };
  return { get: (k: string) => values[k] } as unknown as ConfigService;
}

/** A well-formed ContentAndApprovals item as Twilio returns it. */
function rawItem(overrides: Record<string, unknown> = {}) {
  return {
    sid: 'HX00000000000000000000000000000001',
    friendly_name: 'primeiro_contato',
    language: 'pt_BR',
    variables: { '1': 'João' },
    types: { 'twilio/text': { body: 'Olá {{1}}' } },
    approval_requests: {
      name: 'primeiro_contato',
      category: 'MARKETING',
      status: 'approved',
      rejection_reason: '',
    },
    ...overrides,
  };
}

describe('TwilioContentService.listContentAndApprovals', () => {
  it('GETs /v1/ContentAndApprovals?PageSize=100 with Basic auth and maps the fields', async () => {
    let seenAuth: string | null = null;
    let seenPageSize: string | null = null;
    server.use(
      http.get(LIST_URL, ({ request }) => {
        seenAuth = request.headers.get('authorization');
        seenPageSize = new URL(request.url).searchParams.get('PageSize');
        return HttpResponse.json({
          contents: [rawItem()],
          meta: { next_page_url: null },
        });
      }),
    );

    const svc = new TwilioContentService(makeConfig());
    const items = await svc.listContentAndApprovals();

    const expectedAuth = `Basic ${Buffer.from(`${ACCOUNT_SID}:${AUTH_TOKEN}`).toString('base64')}`;
    expect(seenAuth).toBe(expectedAuth);
    expect(seenPageSize).toBe('100');
    expect(items).toEqual([
      {
        sid: 'HX00000000000000000000000000000001',
        friendlyName: 'primeiro_contato',
        language: 'pt_BR',
        variables: { '1': 'João' },
        types: { 'twilio/text': { body: 'Olá {{1}}' } },
        approval: {
          name: 'primeiro_contato',
          category: 'MARKETING',
          status: 'approved',
          rejectionReason: '',
        },
      },
    ]);
  });

  it('follows meta.next_page_url across pages until exhausted', async () => {
    const page2Url = `${LIST_URL}?PageSize=100&PageToken=PAsecondpage`;
    const requested: string[] = [];
    server.use(
      http.get(LIST_URL, ({ request }) => {
        requested.push(request.url);
        const token = new URL(request.url).searchParams.get('PageToken');
        if (!token) {
          return HttpResponse.json({
            contents: [
              rawItem({ sid: 'HX00000000000000000000000000000001' }),
              rawItem({ sid: 'HX00000000000000000000000000000002' }),
            ],
            meta: { next_page_url: page2Url },
          });
        }
        return HttpResponse.json({
          contents: [rawItem({ sid: 'HX00000000000000000000000000000003' })],
          meta: { next_page_url: null },
        });
      }),
    );

    const svc = new TwilioContentService(makeConfig());
    const items = await svc.listContentAndApprovals();

    expect(requested).toHaveLength(2);
    expect(items.map((i) => i.sid)).toEqual([
      'HX00000000000000000000000000000001',
      'HX00000000000000000000000000000002',
      'HX00000000000000000000000000000003',
    ]);
  });

  it('skips malformed items (no sid / not an object) without throwing', async () => {
    server.use(
      http.get(LIST_URL, () =>
        HttpResponse.json({
          contents: [
            null,
            'not-an-object',
            { friendly_name: 'sem_sid' },
            rawItem({ sid: 'HX00000000000000000000000000000009' }),
          ],
          meta: { next_page_url: null },
        }),
      ),
    );

    const svc = new TwilioContentService(makeConfig());
    const items = await svc.listContentAndApprovals();

    expect(items).toHaveLength(1);
    expect(items[0].sid).toBe('HX00000000000000000000000000000009');
  });

  it('tolerates missing approval_requests / variables / types shapes', async () => {
    server.use(
      http.get(LIST_URL, () =>
        HttpResponse.json({
          contents: [
            {
              sid: 'HX00000000000000000000000000000010',
              friendly_name: 'rascunho_nunca_submetido',
              language: 'pt_BR',
              // no variables, no types, no approval_requests
            },
          ],
          meta: { next_page_url: null },
        }),
      ),
    );

    const svc = new TwilioContentService(makeConfig());
    const items = await svc.listContentAndApprovals();

    expect(items).toEqual([
      {
        sid: 'HX00000000000000000000000000000010',
        friendlyName: 'rascunho_nunca_submetido',
        language: 'pt_BR',
        variables: {},
        types: {},
        approval: undefined,
      },
    ]);
  });

  it('expõe configured=false sem credenciais (deploy sem grupo Twilio)', () => {
    const svc = new TwilioContentService(
      makeConfig({ TWILIO_ACCOUNT_SID: undefined, TWILIO_AUTH_TOKEN: undefined }),
    );
    expect(svc.configured).toBe(false);
  });

  it('expõe configured=true com credenciais', () => {
    const svc = new TwilioContentService(makeConfig());
    expect(svc.configured).toBe(true);
  });

  it('honours the TWILIO_CONTENT_BASE_URL override (tests/dev)', async () => {
    const altBase = 'https://content.fake.test';
    server.use(
      http.get(`${altBase}/v1/ContentAndApprovals`, () =>
        HttpResponse.json({
          contents: [rawItem()],
          meta: { next_page_url: null },
        }),
      ),
    );

    const svc = new TwilioContentService(
      makeConfig({ TWILIO_CONTENT_BASE_URL: altBase }),
    );
    const items = await svc.listContentAndApprovals();
    expect(items).toHaveLength(1);
  });
});

// ── T4: create / submit / update draft / delete / fetch approval ────────────

const SID = 'HX00000000000000000000000000000042';

const createInput = {
  friendlyName: 'boas_vindas_v2',
  language: 'pt_BR',
  variables: { '1': 'João' },
  types: { 'twilio/text': { body: 'Olá {{1}}, tudo bem?' } },
};

describe('TwilioContentService.createContent', () => {
  it('POSTa /v1/Content em JSON com friendly_name/language/variables/types e retorna o sid', async () => {
    let seenBody: unknown = null;
    let seenContentType: string | null = null;
    server.use(
      http.post(`${BASE}/v1/Content`, async ({ request }) => {
        seenContentType = request.headers.get('content-type');
        seenBody = await request.json();
        return HttpResponse.json({ sid: SID });
      }),
    );

    const svc = new TwilioContentService(makeConfig());
    const result = await svc.createContent(createInput);

    expect(result).toEqual({ sid: SID });
    expect(seenContentType).toContain('application/json');
    expect(seenBody).toEqual({
      friendly_name: 'boas_vindas_v2',
      language: 'pt_BR',
      variables: { '1': 'João' },
      types: { 'twilio/text': { body: 'Olá {{1}}, tudo bem?' } },
    });
  });

  it('mapeia erro 4xx da Twilio ({message, code}) para DomainError com a mensagem real', async () => {
    server.use(
      http.post(`${BASE}/v1/Content`, () =>
        HttpResponse.json(
          { message: 'Invalid language code', code: 20422 },
          { status: 400 },
        ),
      ),
    );

    const svc = new TwilioContentService(makeConfig());
    const err = await svc.createContent(createInput).catch((e) => e);

    expect(err).toBeInstanceOf(DomainError);
    expect(err.code).toBe('twilio_content.create_failed');
    expect(err.message).toContain('Invalid language code');
    expect(err.status).toBe(400);
    expect(err.detail).toContain('20422');
  });

  it('lança twilio_content.not_configured sem credenciais', async () => {
    const svc = new TwilioContentService(
      makeConfig({ TWILIO_ACCOUNT_SID: undefined, TWILIO_AUTH_TOKEN: undefined }),
    );
    const err = await svc.createContent(createInput).catch((e) => e);
    expect(err).toBeInstanceOf(DomainError);
    expect(err.code).toBe('twilio_content.not_configured');
  });

  it('lança DomainError quando a resposta não traz sid', async () => {
    server.use(
      http.post(`${BASE}/v1/Content`, () => HttpResponse.json({ ok: true })),
    );
    const svc = new TwilioContentService(makeConfig());
    const err = await svc.createContent(createInput).catch((e) => e);
    expect(err).toBeInstanceOf(DomainError);
    expect(err.code).toBe('twilio_content.invalid_response');
  });
});

describe('TwilioContentService.submitApproval', () => {
  it('POSTa /v1/Content/{sid}/ApprovalRequests/whatsapp com {name, category} e retorna o status', async () => {
    let seenBody: unknown = null;
    server.use(
      http.post(
        `${BASE}/v1/Content/${SID}/ApprovalRequests/whatsapp`,
        async ({ request }) => {
          seenBody = await request.json();
          return HttpResponse.json({
            name: 'boas_vindas_v2',
            category: 'MARKETING',
            status: 'received',
          });
        },
      ),
    );

    const svc = new TwilioContentService(makeConfig());
    const result = await svc.submitApproval(SID, {
      name: 'boas_vindas_v2',
      category: 'MARKETING',
    });

    expect(result).toEqual({ status: 'received' });
    expect(seenBody).toEqual({ name: 'boas_vindas_v2', category: 'MARKETING' });
  });

  it('mapeia erro da Twilio para twilio_content.submit_failed com a mensagem real', async () => {
    server.use(
      http.post(`${BASE}/v1/Content/${SID}/ApprovalRequests/whatsapp`, () =>
        HttpResponse.json(
          { message: 'Name already in use', code: 21710 },
          { status: 409 },
        ),
      ),
    );

    const svc = new TwilioContentService(makeConfig());
    const err = await svc
      .submitApproval(SID, { name: 'dup', category: 'MARKETING' })
      .catch((e) => e);

    expect(err).toBeInstanceOf(DomainError);
    expect(err.code).toBe('twilio_content.submit_failed');
    expect(err.message).toContain('Name already in use');
  });
});

describe('TwilioContentService.updateDraft', () => {
  it('faz PUT /v1/Content/{sid} com o body JSON de criação', async () => {
    let seenBody: unknown = null;
    server.use(
      http.put(`${BASE}/v1/Content/${SID}`, async ({ request }) => {
        seenBody = await request.json();
        return HttpResponse.json({ sid: SID });
      }),
    );

    const svc = new TwilioContentService(makeConfig());
    await svc.updateDraft(SID, createInput);

    expect(seenBody).toEqual({
      friendly_name: 'boas_vindas_v2',
      language: 'pt_BR',
      variables: { '1': 'João' },
      types: { 'twilio/text': { body: 'Olá {{1}}, tudo bem?' } },
    });
  });

  it('mapeia a recusa pós-submissão para DomainError PT-BR claro (imutável, clonar _v2)', async () => {
    server.use(
      http.put(`${BASE}/v1/Content/${SID}`, () =>
        HttpResponse.json(
          { message: 'Content cannot be updated after approval request', code: 21720 },
          { status: 409 },
        ),
      ),
    );

    const svc = new TwilioContentService(makeConfig());
    const err = await svc.updateDraft(SID, createInput).catch((e) => e);

    expect(err).toBeInstanceOf(DomainError);
    expect(err.code).toBe('twilio_content.update_rejected');
    expect(err.message).toContain('Content cannot be updated after approval request');
    expect(err.message).toMatch(/imutáve/i);
    expect(err.message).toContain('_v2');
  });
});

describe('TwilioContentService.deleteContent', () => {
  it('faz DELETE /v1/Content/{sid} com deleteInWaba=true', async () => {
    let seenUrl: string | null = null;
    server.use(
      http.delete(`${BASE}/v1/Content/${SID}`, ({ request }) => {
        seenUrl = request.url;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    const svc = new TwilioContentService(makeConfig());
    await svc.deleteContent(SID);

    expect(seenUrl).toContain('deleteInWaba=true');
  });

  it('tolera 404 (já removido na Twilio) sem lançar', async () => {
    server.use(
      http.delete(`${BASE}/v1/Content/${SID}`, () =>
        HttpResponse.json({ message: 'Not found', code: 20404 }, { status: 404 }),
      ),
    );

    const svc = new TwilioContentService(makeConfig());
    await expect(svc.deleteContent(SID)).resolves.toBeUndefined();
  });

  it('mapeia outros erros para twilio_content.delete_failed', async () => {
    server.use(
      http.delete(`${BASE}/v1/Content/${SID}`, () =>
        HttpResponse.json(
          { message: 'Cannot delete content in use', code: 21730 },
          { status: 409 },
        ),
      ),
    );

    const svc = new TwilioContentService(makeConfig());
    const err = await svc.deleteContent(SID).catch((e) => e);

    expect(err).toBeInstanceOf(DomainError);
    expect(err.code).toBe('twilio_content.delete_failed');
    expect(err.message).toContain('Cannot delete content in use');
  });
});

describe('TwilioContentService.fetchApprovalStatus', () => {
  it('GET /v1/Content/{sid}/ApprovalRequests → normaliza o bloco whatsapp', async () => {
    server.use(
      http.get(`${BASE}/v1/Content/${SID}/ApprovalRequests`, () =>
        HttpResponse.json({
          whatsapp: {
            name: 'boas_vindas_v2',
            category: 'MARKETING',
            status: 'pending',
            rejection_reason: '',
          },
        }),
      ),
    );

    const svc = new TwilioContentService(makeConfig());
    const approval = await svc.fetchApprovalStatus(SID);

    expect(approval).toEqual({
      name: 'boas_vindas_v2',
      category: 'MARKETING',
      status: 'pending',
      rejectionReason: '',
    });
  });

  it('retorna null quando nunca foi submetido (sem bloco whatsapp)', async () => {
    server.use(
      http.get(`${BASE}/v1/Content/${SID}/ApprovalRequests`, () =>
        HttpResponse.json({}),
      ),
    );

    const svc = new TwilioContentService(makeConfig());
    await expect(svc.fetchApprovalStatus(SID)).resolves.toBeNull();
  });

  it('mapeia erro da Twilio para twilio_content.approval_fetch_failed', async () => {
    server.use(
      http.get(`${BASE}/v1/Content/${SID}/ApprovalRequests`, () =>
        HttpResponse.json({ message: 'Not found', code: 20404 }, { status: 404 }),
      ),
    );

    const svc = new TwilioContentService(makeConfig());
    const err = await svc.fetchApprovalStatus(SID).catch((e) => e);

    expect(err).toBeInstanceOf(DomainError);
    expect(err.code).toBe('twilio_content.approval_fetch_failed');
    expect(err.status).toBe(404);
  });
});
