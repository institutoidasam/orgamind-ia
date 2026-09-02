import { describe, it, expect } from 'vitest';

import {
  GENERIC_TEMPLATE_PROVIDERS,
  TEMPLATE_LANGUAGE_OPTIONS,
  createTemplateSchema,
  templateSchema,
  updateTemplateSchema,
} from './schemas';

describe('createTemplateSchema.metaName', () => {
  it('rejects uppercase (must match the lowercase-only backend rule)', () => {
    // Previously the regex carried the `/i` flag, so `Apoiadores` passed the
    // form but the backend 400'd. The front must mirror the backend.
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

  it('accepts a valid HX… Content SID for the TWILIO provider', () => {
    // Multi-provider channels: a Content SID only makes sense together with
    // provider=TWILIO — see the createTemplateSchema.provider describe block
    // below for the cross-field rule itself.
    const parsed = createTemplateSchema.safeParse({
      metaName: 'oficial_cold',
      body: 'Olá',
      kind: 'TEXT',
      provider: 'TWILIO',
      twilioContentSid: HX,
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an invalid Content SID', () => {
    const parsed = createTemplateSchema.safeParse({
      metaName: 'oficial_cold',
      body: 'Olá',
      kind: 'TEXT',
      twilioContentSid: 'nope',
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts an empty string (unset field from the form)', () => {
    const parsed = createTemplateSchema.safeParse({
      metaName: 'oficial_cold',
      body: 'Olá',
      kind: 'TEXT',
      twilioContentSid: '',
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts an absent Content SID', () => {
    const parsed = createTemplateSchema.safeParse({
      metaName: 'oficial_cold',
      body: 'Olá',
      kind: 'TEXT',
    });
    expect(parsed.success).toBe(true);
  });
});

describe('createTemplateSchema.provider', () => {
  const HX = 'HX0123456789abcdef0123456789abcdef';

  it('defaults to EVOLUTION when absent', () => {
    const parsed = createTemplateSchema.safeParse({
      metaName: 'boas_vindas',
      body: 'Olá',
      kind: 'TEXT',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.provider).toBe('EVOLUTION');
  });

  // ZERNIO fora: este endpoint grava `status: APPROVED` sem falar com provedor
  // nenhum. Para EVOLUTION isso é correto (não há aprovação da Meta); para
  // ZERNIO seria uma row "aprovada" de um template que a Meta nunca viu — passa
  // no gate de campanha e só explode no envio. Espelha o refine do backend.
  it('accepts every ChannelProvider value EXCEPT Zernio', () => {
    for (const provider of ['EVOLUTION', 'TWILIO', 'META'] as const) {
      const parsed = createTemplateSchema.safeParse({
        metaName: 'boas_vindas',
        body: 'Olá',
        kind: 'TEXT',
        provider,
        ...(provider === 'TWILIO' ? { twilioContentSid: HX } : {}),
      });
      expect(parsed.success).toBe(true);
    }
  });

  it('★ rejects ZERNIO — o template tem de nascer NA META (com o rótulo dos botões casado)', () => {
    const parsed = createTemplateSchema.safeParse({
      metaName: 'reapresentacao_optin',
      body: 'Olá',
      kind: 'TEXT',
      provider: 'ZERNIO',
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.path).toEqual(['provider']);
      expect(parsed.error.issues[0]?.message).toContain('Novo template Zernio');
    }
  });

  it('GENERIC_TEMPLATE_PROVIDERS não oferece ZERNIO ao select', () => {
    expect(GENERIC_TEMPLATE_PROVIDERS).not.toContain('ZERNIO');
    expect(GENERIC_TEMPLATE_PROVIDERS).toContain('EVOLUTION');
  });

  // Pedido do cliente (2026-08-25): Twilio saiu das opções de criação — o
  // provedor ativo agora é o GOZAP.
  it('GENERIC_TEMPLATE_PROVIDERS não oferece TWILIO ao select e oferece GOZAP', () => {
    expect(GENERIC_TEMPLATE_PROVIDERS).not.toContain('TWILIO');
    expect(GENERIC_TEMPLATE_PROVIDERS).toContain('GOZAP');
  });

  it('rejects TWILIO without a Content SID, with a PT-BR message', () => {
    const parsed = createTemplateSchema.safeParse({
      metaName: 'oficial_cold',
      body: 'Olá',
      kind: 'TEXT',
      provider: 'TWILIO',
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const issue = parsed.error.issues.find(
        (i) => i.path.join('.') === 'twilioContentSid',
      );
      expect(issue?.message).toMatch(/exigem o campo Content SID/);
    }
  });

  it('rejects TWILIO with an empty-string Content SID', () => {
    const parsed = createTemplateSchema.safeParse({
      metaName: 'oficial_cold',
      body: 'Olá',
      kind: 'TEXT',
      provider: 'TWILIO',
      twilioContentSid: '',
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts TWILIO with a valid Content SID', () => {
    const parsed = createTemplateSchema.safeParse({
      metaName: 'oficial_cold',
      body: 'Olá',
      kind: 'TEXT',
      provider: 'TWILIO',
      twilioContentSid: HX,
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a non-TWILIO provider carrying a Content SID', () => {
    const parsed = createTemplateSchema.safeParse({
      metaName: 'boas_vindas',
      body: 'Olá',
      kind: 'TEXT',
      provider: 'EVOLUTION',
      twilioContentSid: HX,
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const issue = parsed.error.issues.find(
        (i) => i.path.join('.') === 'twilioContentSid',
      );
      expect(issue?.message).toMatch(/só é permitido para templates do provedor Twilio/);
    }
  });

  it('accepts a non-TWILIO provider with no Content SID', () => {
    const parsed = createTemplateSchema.safeParse({
      metaName: 'boas_vindas',
      body: 'Olá',
      kind: 'TEXT',
      provider: 'EVOLUTION',
    });
    expect(parsed.success).toBe(true);
  });
});

describe('updateTemplateSchema.provider', () => {
  it('is optional (a partial update need not touch the provider)', () => {
    const parsed = updateTemplateSchema.safeParse({ language: 'en_US' });
    expect(parsed.success).toBe(true);
  });

  it('accepts an explicit provider change', () => {
    const parsed = updateTemplateSchema.safeParse({ provider: 'TWILIO' });
    expect(parsed.success).toBe(true);
  });

  it('accepts an explicit null twilioContentSid (clearing it)', () => {
    const parsed = updateTemplateSchema.safeParse({
      provider: 'EVOLUTION',
      twilioContentSid: null,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.twilioContentSid).toBeNull();
  });
});

describe('templateSchema.provider', () => {
  const base = {
    id: 't1',
    metaName: 'boas_vindas',
    language: 'pt_BR',
    body: 'Olá',
    variables: [],
    status: 'APPROVED' as const,
    category: 'UTILITY' as const,
    createdAt: new Date('2026-06-01T00:00:00Z'),
  };

  it('is required — the backend always includes it in the response', () => {
    const parsed = templateSchema.safeParse(base);
    expect(parsed.success).toBe(false);
  });

  it('accepts a full response payload with provider', () => {
    const parsed = templateSchema.safeParse({ ...base, provider: 'ZERNIO' });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.provider).toBe('ZERNIO');
  });
});

// twilio-platform T3 — the listing response now carries the approval-sync
// columns written by the backend's 2-min job; the front schema must keep them.
describe('templateSchema — Twilio approval-sync fields', () => {
  const base = {
    id: 't1',
    metaName: 'boas_vindas',
    language: 'pt_BR',
    body: 'Olá',
    variables: [],
    status: 'REJECTED' as const,
    category: 'UTILITY' as const,
    createdAt: new Date('2026-06-01T00:00:00Z'),
    provider: 'TWILIO' as const,
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
      status: 'APPROVED',
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

  it('accepts payloads without the sync fields (older backends)', () => {
    const parsed = templateSchema.safeParse({
      ...base,
      provider: 'EVOLUTION',
      status: 'APPROVED',
    });
    expect(parsed.success).toBe(true);
  });

  it('PAUSED is a valid status in the response payload', () => {
    const parsed = templateSchema.safeParse({ ...base, status: 'PAUSED' });
    expect(parsed.success).toBe(true);
  });
});

// Pedido do cliente (2026-08-25): o campo idioma virou um SELECT — pt_BR é o
// padrão, os únicos outros idiomas oferecidos são os poucos realmente usados.
describe('TEMPLATE_LANGUAGE_OPTIONS', () => {
  it('tem pt_BR como primeira opção (padrão)', () => {
    expect(TEMPLATE_LANGUAGE_OPTIONS[0]?.value).toBe('pt_BR');
  });

  it('oferece só pt_BR, en_US e es_ES', () => {
    expect(TEMPLATE_LANGUAGE_OPTIONS.map((o) => o.value)).toEqual([
      'pt_BR',
      'en_US',
      'es_ES',
    ]);
  });
});
