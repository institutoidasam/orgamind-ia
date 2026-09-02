import { describe, it, expect } from 'vitest';

import { sendTemplateInputSchema } from './whatsapp.schema';

describe('sendTemplateInputSchema.zernioAccountId', () => {
  const base = { toE164: '+5592987654321', templateName: 'welcome' };

  it('is optional — parses fine without it (compat with other providers)', () => {
    const parsed = sendTemplateInputSchema.parse(base);
    expect(parsed.zernioAccountId).toBeUndefined();
  });

  it('preserves a provided zernioAccountId (per-provider field pattern)', () => {
    // Mirrors evolutionInstanceName / senderPhoneE164 / twilioMessagingServiceSid:
    // a provider-scoped opt-in field that must survive parsing, not be stripped.
    const parsed = sendTemplateInputSchema.parse({
      ...base,
      zernioAccountId: 'acc_abc123',
    });
    expect(parsed.zernioAccountId).toBe('acc_abc123');
  });

  it('rejects a non-string zernioAccountId', () => {
    const r = sendTemplateInputSchema.safeParse({
      ...base,
      zernioAccountId: 123 as unknown as string,
    });
    expect(r.success).toBe(false);
  });
});

describe('sendTemplateInputSchema.headerMedia', () => {
  const base = { toE164: '+5592987654321', templateName: 'welcome' };

  it('is optional — templates sem header de mídia seguem parseando', () => {
    expect(sendTemplateInputSchema.parse(base).headerMedia).toBeUndefined();
  });

  it('aceita um header por LINK (URL pública, sem auth)', () => {
    const parsed = sendTemplateInputSchema.parse({
      ...base,
      headerMedia: { type: 'image', link: 'https://picoa.app.br/arte.png' },
    });
    expect(parsed.headerMedia).toEqual({
      type: 'image',
      link: 'https://picoa.app.br/arte.png',
    });
  });

  it('aceita um header por ID de mídia da Meta e um filename em document', () => {
    const parsed = sendTemplateInputSchema.parse({
      ...base,
      headerMedia: { type: 'document', id: '1234567890', filename: 'nota.pdf' },
    });
    expect(parsed.headerMedia?.id).toBe('1234567890');
    expect(parsed.headerMedia?.filename).toBe('nota.pdf');
  });

  // A doc é explícita: "Provide exactly one of `link` or `id`". Barrar aqui é
  // barato; deixar passar custa um 4xx no meio de uma campanha.
  it('rejeita link E id juntos (a doc exige exatamente um)', () => {
    const r = sendTemplateInputSchema.safeParse({
      ...base,
      headerMedia: { type: 'image', link: 'https://x/y.png', id: '123' },
    });
    expect(r.success).toBe(false);
  });

  it('rejeita headerMedia sem link e sem id', () => {
    const r = sendTemplateInputSchema.safeParse({
      ...base,
      headerMedia: { type: 'image' },
    });
    expect(r.success).toBe(false);
  });

  it('rejeita um type fora do enum da Meta (image|video|document)', () => {
    const r = sendTemplateInputSchema.safeParse({
      ...base,
      headerMedia: { type: 'audio', link: 'https://x/y.ogg' },
    });
    expect(r.success).toBe(false);
  });
});
