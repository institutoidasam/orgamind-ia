import { describe, it, expect, vi } from 'vitest';
import { mockDeep } from 'vitest-mock-extended';
import type { Queue } from 'bullmq';
import type Redis from 'ioredis';
import { ChatIngestService } from './chat-ingest.service';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { WhatsappProvidersService } from '../whatsapp-providers/whatsapp-providers.service';
import { ChatEventsService } from './chat-events.service';
import { ConsentService } from '../consent/consent.service';
import { OptInLinkService } from '../consent/optin-link.service';
import type { ChatMediaDownloadJob, BotReplyJob } from '../queue/queue.constants';

function make(botId: string | null) {
  const prisma = mockDeep<PrismaService>();
  const wa = mockDeep<WhatsappProvidersService>();
  const events = mockDeep<ChatEventsService>();
  const redis = mockDeep<Redis>();
  const mediaQueue = mockDeep<Queue<ChatMediaDownloadJob>>();
  const botQueue = mockDeep<Queue<BotReplyJob>>();
  redis.get.mockResolvedValue(null);
  prisma.channel.findUnique.mockResolvedValue({ evolutionInstanceName: 'picoa-x', botId } as never);
  prisma.contact.findMany.mockResolvedValue([]);
  prisma.conversation.upsert.mockResolvedValue({ id: 'c1' } as never);
  prisma.message.create.mockResolvedValue({ id: 'm1', media: null } as never);
  prisma.conversation.update.mockResolvedValue({} as never);
  const consent = mockDeep<ConsentService>();
  const links = mockDeep<OptInLinkService>();
  links.matchInbound.mockResolvedValue(null);
  const svc = new ChatIngestService(prisma, wa, events, redis, mediaQueue, botQueue, consent, links);
  return { svc, wa, botQueue };
}

const inboundText = {
  providerMessageId: 'p1', remoteJid: '5592@s.whatsapp.net', phoneE164: '+5592',
  isGroup: false, fromMe: false, kind: 'TEXT', text: 'oi', transcript: null, media: null,
  quotedWaMessageId: null, quotedPreview: null, pushName: 'Zé', altJid: null, receivedAt: new Date(),
};

describe('ChatIngestService bot enqueue', () => {
  it('enqueues bot.reply for inbound TEXT on an instance with a bot', async () => {
    const { svc, wa, botQueue } = make('bot1');
    wa.parseInboundChatMessages.mockReturnValue([inboundText] as never);
    await svc.ingestFromWebhook({}, 'i1');
    expect(botQueue.add).toHaveBeenCalledWith(
      'reply', { conversationId: 'c1', messageId: 'm1' }, { jobId: 'm1' },
    );
  });

  it('does NOT enqueue when the instance has no bot', async () => {
    const { svc, wa, botQueue } = make(null);
    wa.parseInboundChatMessages.mockReturnValue([inboundText] as never);
    await svc.ingestFromWebhook({}, 'i1');
    expect(botQueue.add).not.toHaveBeenCalled();
  });
});
