import { describe, it, expect } from 'vitest';

import {
  createTemplateSchema,
  updateTemplateSchema,
  listTemplatesQuerySchema,
  channelProviderEnum,
  templateSchema,
  createTwilioTemplateSchema,
  updateTwilioDraftSchema,
} from './template.schema';

describe('createTemplateSchema.metaName', () => {
  it('rejects uppercase (Meta names are lowercase-only)', () => {
    // A name like `Apoiadores` must be rejected — the sync key is
    // case-sensitive, so uppercase would diverge from what Meta reports back.
    const parsed = createTemplateSchema.safeParse({
      metaName: 'Apoiadores',
      body: 'Olá',
      kind: 'TEXT',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects names with spaces', () => {
    const parsed = createTemplateSchema.safeParse({
      metaName: 'convite apoiadores',
      body: 'Olá',
      kind: 'TEXT',
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts lowercase letters, digits and underscores', () => {
    const parsed = createTemplateSchema.safeParse({
      metaName: 'convite_apoiadores',
      body: 'Olá',
      kind: 'TEXT',
    });
    expect(parsed.success).toBe(true);
  });
});

describe('createTemplateSchema.twilioContentSid', () => {
  const HX = 'HX0123456789abcdef0123456789abcdef';

  it('accepts a valid HX… Content SID (provider TWILIO)', () => {
    const parsed = createTemplateSchema.safeParse({
      metaName: 'convite_apoiadores',
      body: 'Olá',
      kind: 'TEXT',
      provider: 'TWILIO',
      twilioContentSid: HX,
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an invalid Content SID (not HX…)', () => {
    const parsed = createTemplateSchema.safeParse({
      metaName: 'convite_apoiadores',
      body: 'Olá',
      kind: 'TEXT',
      provider: 'TWILIO',
      twilioContentSid: 'not-a-sid',
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts an absent Content SID', () => {
    const parsed = createTemplateSchema.safeParse({
      metaName: 'convite_apoiadores',
      body: 'Olá',
      kind: 'TEXT',
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts a null Content SID', () => {
    const parsed = createTemplateSchema.safeParse({
      metaName: 'convite_apoiadores',
      body: 'Olá',
      kind: 'TEXT',
      twilioContentSid: null,
    });
    expect(parsed.success).toBe(true);
  });
});

describe('createTemplateSchema.body', () => {
  it('accepts an empty body for interactive kinds (LIST) with a config', () => {
    // The form sends `body: ''` for interactive kinds — content lives in
    // interactiveConfig. An empty string must pass; the TEXT-only refine is
    // what guarantees a non-empty body for TEXT.
    const parsed = createTemplateSchema.safeParse({
      metaName: 'menu_suporte',
      body: '',
      kind: 'LIST',
      interactiveConfig: {
        title: 'Como podemos ajudar?',
        description: 'Escolha uma opção',
        buttonText: 'Ver opções',
        sections: [{ title: 'Suporte', rows: [{ rowId: 'r1', title: 'Bug' }] }],
      },
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects TEXT with an empty body', () => {
    const parsed = createTemplateSchema.safeParse({
      metaName: 'boas_vindas',
      body: '',
      kind: 'TEXT',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects TEXT with an absent body', () => {
    const parsed = createTemplateSchema.safeParse({
      metaName: 'boas_vindas',
      kind: 'TEXT',
    });
    expect(parsed.success).toBe(false);
  });
});

describe('channelProviderEnum', () => {
  it('accepts exactly EVOLUTION | TWILIO | ZERNIO | META', () => {
    for (const value of ['EVOLUTION', 'TWILIO', 'ZERNIO', 'META']) {
      expect(channelProviderEnum.safeParse(value).success).toBe(true);
    }
  });

  it('rejects an unknown provider', () => {
    expect(channelProviderEnum.safeParse('WHATSAPP_CLOUD').success).toBe(
      false,
    );
  });

  it('rejects lowercase (provider values are UPPERCASE)', () => {
    expect(channelProviderEnum.safeParse('evolution').success).toBe(false);
  });
});

describe('createTemplateSchema.provider', () => {
  const HX = 'HX0123456789abcdef0123456789abcdef';

  it('defaults to EVOLUTION when omitted', () => {
    const parsed = createTemplateSchema.parse({
      metaName: 'boas_vindas',
      body: 'Olá',
      kind: 'TEXT',
    });
    expect(parsed.provider).toBe('EVOLUTION');
  });

  it('accepts an explicit provider', () => {
    const parsed = createTemplateSchema.parse({
      metaName: 'boas_vindas',
      body: 'Olá',
      kind: 'TEXT',
      provider: 'META',
    });
    expect(parsed.provider).toBe('META');
  });

  // ZB — este endpoint grava `status: APPROVED` sem falar com provedor nenhum.
  // Para ZERNIO isso produzia uma row APROVADA de um template que não existe na
  // Meta: passava no gate de campanha e só quebrava no envio. ZERNIO agora só
  // nasce por POST /templates/zernio (que cria de verdade e nasce PENDING).
  it('rejects ZERNIO, apontando a rota que cria o template de verdade', () => {
    const parsed = createTemplateSchema.safeParse({
      metaName: 'boas_vindas',
      body: 'Olá',
      kind: 'TEXT',
      provider: 'ZERNIO',
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toContain('Novo template Zernio');
  });

  it('rejects TWILIO without twilioContentSid, with a PT-BR message', () => {
    const parsed = createTemplateSchema.safeParse({
      metaName: 'boas_vindas',
      body: 'Olá',
      kind: 'TEXT',
      provider: 'TWILIO',
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const message = parsed.error.issues
        .map((i) => i.message)
        .join(' | ');
      expect(message).toMatch(/TWILIO/);
      expect(message).toMatch(/twilioContentSid/);
      // PT-BR marker — avoids the generic English zod default message.
      expect(message.toLowerCase()).toMatch(/exig|obrigat/);
    }
  });

  it('rejects TWILIO with a null twilioContentSid', () => {
    const parsed = createTemplateSchema.safeParse({
      metaName: 'boas_vindas',
      body: 'Olá',
      kind: 'TEXT',
      provider: 'TWILIO',
      twilioContentSid: null,
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts TWILIO with a valid twilioContentSid', () => {
    const parsed = createTemplateSchema.safeParse({
      metaName: 'boas_vindas',
      body: 'Olá',
      kind: 'TEXT',
      provider: 'TWILIO',
      twilioContentSid: HX,
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects EVOLUTION with a twilioContentSid set, with a PT-BR message', () => {
    const parsed = createTemplateSchema.safeParse({
      metaName: 'boas_vindas',
      body: 'Olá',
      kind: 'TEXT',
      provider: 'EVOLUTION',
      twilioContentSid: HX,
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const message = parsed.error.issues.map((i) => i.message).join(' | ');
      expect(message).toMatch(/TWILIO/);
      expect(message.toLowerCase()).toMatch(/permit/);
    }
  });

  it('rejects ZERNIO/META with a twilioContentSid set', () => {
    for (const provider of ['ZERNIO', 'META']) {
      const parsed = createTemplateSchema.safeParse({
        metaName: 'boas_vindas',
        body: 'Olá',
        kind: 'TEXT',
        provider,
        twilioContentSid: HX,
      });
      expect(parsed.success).toBe(false);
    }
  });

  it('EVOLUTION (default) with no twilioContentSid stays valid', () => {
    const parsed = createTemplateSchema.safeParse({
      metaName: 'boas_vindas',
      body: 'Olá',
      kind: 'TEXT',
    });
    expect(parsed.success).toBe(true);
  });
});

describe('updateTemplateSchema.provider', () => {
  it('provider is optional', () => {
    const parsed = updateTemplateSchema.safeParse({ language: 'en_US' });
    expect(parsed.success).toBe(true);
  });

  it('accepts a valid provider value', () => {
    const parsed = updateTemplateSchema.safeParse({ provider: 'TWILIO' });
    expect(parsed.success).toBe(true);
  });

  it('rejects an invalid provider value', () => {
    const parsed = updateTemplateSchema.safeParse({ provider: 'BOGUS' });
    expect(parsed.success).toBe(false);
  });
});

describe('listTemplatesQuerySchema', () => {
  it('accepts an absent provider filter', () => {
    expect(listTemplatesQuerySchema.safeParse({}).success).toBe(true);
  });

  it('accepts a valid provider filter', () => {
    const parsed = listTemplatesQuerySchema.safeParse({ provider: 'TWILIO' });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.provider).toBe('TWILIO');
  });

  it('rejects an invalid provider filter', () => {
    expect(
      listTemplatesQuerySchema.safeParse({ provider: 'BOGUS' }).success,
    ).toBe(false);
  });
});

// twilio-platform T3 — the response contract exposes the approval-sync columns
// (twilioApprovalStatus raw, twilioRejectionReason, lastTwilioSyncAt) so the
// frontend catalog can show real Twilio status + sync freshness.
describe('templateSchema — Twilio approval-sync fields', () => {
  const base = {
    id: 't1',
    metaName: 'convite_apoiadores',
    language: 'pt_BR',
    body: 'Olá',
    variables: [],
    status: 'APPROVED',
    category: 'UTILITY',
    createdAt: '2026-07-10T00:00:00.000Z',
    kind: 'TEXT',
    provider: 'TWILIO',
  };

  it('preserves twilioApprovalStatus, twilioRejectionReason and lastTwilioSyncAt', () => {
    const parsed = templateSchema.safeParse({
      ...base,
      twilioApprovalStatus: 'rejected',
      twilioRejectionReason: 'Categoria incorreta',
      lastTwilioSyncAt: '2026-07-10T12:00:00.000Z',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.twilioApprovalStatus).toBe('rejected');
      expect(parsed.data.twilioRejectionReason).toBe('Categoria incorreta');
      expect(parsed.data.lastTwilioSyncAt).toEqual(
        new Date('2026-07-10T12:00:00.000Z'),
      );
    }
  });

  it('accepts null sync fields (rows never touched by the sync job)', () => {
    const parsed = templateSchema.safeParse({
      ...base,
      provider: 'EVOLUTION',
      twilioApprovalStatus: null,
      twilioRejectionReason: null,
      lastTwilioSyncAt: null,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.twilioApprovalStatus).toBeNull();
      expect(parsed.data.lastTwilioSyncAt).toBeNull();
    }
  });

  it('accepts rows without the sync fields (legacy payloads)', () => {
    const parsed = templateSchema.safeParse({ ...base, provider: 'EVOLUTION' });
    expect(parsed.success).toBe(true);
  });

  it('PAUSED is a valid status in the response contract', () => {
    const parsed = templateSchema.safeParse({ ...base, status: 'PAUSED' });
    expect(parsed.success).toBe(true);
  });
});

// twilio-platform T4 — contratos dos content types suportados. Limites de
// caracteres/regras de variáveis ficam na validação pura (PT-BR agregada,
// twilio-template-validation.ts); aqui só o SHAPE.
describe('createTwilioTemplateSchema', () => {
  it('twilio/text: aplica defaults (language pt_BR, category MARKETING, variables {})', () => {
    const parsed = createTwilioTemplateSchema.safeParse({
      contentType: 'twilio/text',
      name: 'aviso_geral',
      body: 'Olá, tudo bem?',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toMatchObject({
        language: 'pt_BR',
        category: 'MARKETING',
        variables: {},
      });
    }
  });

  it('twilio/media: aceita media[]', () => {
    const parsed = createTwilioTemplateSchema.safeParse({
      contentType: 'twilio/media',
      name: 'foto_produto',
      body: 'Veja a novidade',
      media: ['https://exemplo.com/foto.jpg'],
    });
    expect(parsed.success).toBe(true);
  });

  it('twilio/quick-reply: aceita actions {title, id}', () => {
    const parsed = createTwilioTemplateSchema.safeParse({
      contentType: 'twilio/quick-reply',
      name: 'confirmacao',
      body: 'Confirma?',
      actions: [{ title: 'Sim', id: 'yes' }],
    });
    expect(parsed.success).toBe(true);
  });

  it('twilio/call-to-action: aceita actions URL e PHONE_NUMBER', () => {
    const parsed = createTwilioTemplateSchema.safeParse({
      contentType: 'twilio/call-to-action',
      name: 'fale_conosco',
      body: 'Fale com a gente',
      actions: [
        { type: 'URL', title: 'Site', url: 'https://exemplo.com' },
        { type: 'PHONE_NUMBER', title: 'Ligar', phone: '+5592999990000' },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it('rejeita contentType não suportado (ex.: twilio/list-picker — só in-session)', () => {
    const parsed = createTwilioTemplateSchema.safeParse({
      contentType: 'twilio/list-picker',
      name: 'menu',
      body: 'Escolha',
    });
    expect(parsed.success).toBe(false);
  });

  it('exige name', () => {
    const parsed = createTwilioTemplateSchema.safeParse({
      contentType: 'twilio/text',
      body: 'Olá',
    });
    expect(parsed.success).toBe(false);
  });
});

describe('updateTwilioDraftSchema', () => {
  it('não exige name (o nome do rascunho é imutável no orgamind)', () => {
    const parsed = updateTwilioDraftSchema.safeParse({
      contentType: 'twilio/text',
      body: 'Corpo novo',
    });
    expect(parsed.success).toBe(true);
  });
});
