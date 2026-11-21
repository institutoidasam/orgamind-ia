import { inspect } from 'node:util';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockDeep, type MockProxy } from 'vitest-mock-extended';
import { ChatIngestService } from './chat-ingest.service';
import type { PrismaService } from '../../shared/prisma/prisma.service';
import type { WhatsappProvidersService } from '../whatsapp-providers/whatsapp-providers.service';
import type { ChatEventsService } from './chat-events.service';
import type { ConsentService } from '../consent/consent.service';
import type { OptInLinkService } from '../consent/optin-link.service';
import type { InboundChatMessage } from '../whatsapp-providers/ports/message-provider.port';

vi.mock('./conversation-inbound', () =>
  vi.importActual('./conversation-inbound.test-fixtures'),
);

// Lote I, T5 (CI4): a ingestão passa ao rastreio a mensagem gravada (id, tipo,
// texto) para a ciência automática do alerta; o texto nunca vai a log.
const RECEIVED_AT = new Date('2026-11-10T14:00:00Z');
const SECRET_TEXT = 'OK, estou no setor 3 com a Pessoa B';

const inbound = (
  over: Partial<InboundChatMessage> = {},
): InboundChatMessage => ({
  providerMessageId: 'IN-ALERT-1',
  remoteJid: '5592991110001@s.whatsapp.net',
  phoneE164: '+5592991110001',
  isGroup: false,
  fromMe: false,
  kind: 'TEXT',
  text: SECRET_TEXT,
  receivedAt: RECEIVED_AT,
  transcript: null,
  ...over,
});

function build() {
  const prisma = mockDeep<PrismaService>();
  const wa = mockDeep<WhatsappProvidersService>();
  const events = mockDeep<ChatEventsService>();
  const links = mockDeep<OptInLinkService>();
  const redis = {
    set: vi.fn().mockResolvedValue('OK'),
    get: vi.fn().mockResolvedValue(null),
  };
  const queue = { add: vi.fn() } as never;
  const svc = new ChatIngestService(
    prisma,
    wa,
    events,
    redis as never,
    queue,
    queue,
    mockDeep<ConsentService>(),
    links,
  );
  const tracking = { applyReply: vi.fn().mockResolvedValue(null) };
  Object.assign(svc, { teamTracking: tracking });
  links.matchInbound.mockResolvedValue(null);
  prisma.contact.findMany.mockResolvedValue([
    { id: 'ct-a', phoneE164: '+5592991110001' },
  ] as never);
  prisma.message.findFirst.mockResolvedValue(null);
  prisma.channel.findUnique.mockResolvedValue(null);
  prisma.conversation.upsert.mockResolvedValue({
    id: 'conv1',
    contactId: null,
  } as never);
  prisma.message.create.mockResolvedValue({
    id: 'msg-gravada',
    media: null,
  } as never);
  prisma.conversation.update.mockResolvedValue({} as never);
  return { svc, wa, events, tracking };
}

describe('ChatIngestService — ciência do alerta (Lote I, T5)', () => {
  let ctx: ReturnType<typeof build>;
  let wa: MockProxy<WhatsappProvidersService>;
  beforeEach(() => {
    ctx = build();
    wa = ctx.wa;
  });

  it('passa ao rastreio a mensagem gravada: id, kind e texto', async () => {
    wa.parseInboundChatMessages.mockReturnValue([inbound()]);
    await ctx.svc.ingestFromWebhook({}, 'i1');
    expect(ctx.tracking.applyReply).toHaveBeenCalledWith({
      channelId: 'i1',
      contactIds: ['ct-a'],
      receivedAt: RECEIVED_AT,
      message: { id: 'msg-gravada', kind: 'TEXT', text: SECRET_TEXT },
    });
  });

  it('mensagem sem texto (reação) → text null', async () => {
    wa.parseInboundChatMessages.mockReturnValue([
      inbound({ kind: 'UNSUPPORTED', text: undefined }),
    ]);
    await ctx.svc.ingestFromWebhook({}, 'i1');
    expect(ctx.tracking.applyReply).toHaveBeenCalledWith(
      expect.objectContaining({
        message: { id: 'msg-gravada', kind: 'UNSUPPORTED', text: null },
      }),
    );
  });

  it('aceite 17: rastreio lança — mensagem gravada e publicada; log sem o texto', async () => {
    const warn = vi
      .spyOn(Reflect.get(ctx.svc, 'logger') as { warn: () => void }, 'warn')
      .mockImplementation(() => undefined);
    wa.parseInboundChatMessages.mockReturnValue([inbound()]);
    ctx.tracking.applyReply.mockRejectedValue(new Error('db fora'));
    const result = await ctx.svc.ingestFromWebhook({}, 'i1');
    expect(result).toMatchObject({ persisted: 1 });
    expect(ctx.events.publish.mock.calls.flat()).toContainEqual(
      expect.objectContaining({ type: 'message.created' }),
    );
    expect(warn).toHaveBeenCalledTimes(1);
    expect(inspect(warn.mock.calls, { depth: null })).not.toContain(
      SECRET_TEXT,
    );
  });
});
