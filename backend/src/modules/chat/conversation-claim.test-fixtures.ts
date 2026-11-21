import { vi, type Mock } from 'vitest';
import { ChatMediaService } from './chat-media.service';
import { ChatRepository } from './chat.repository';
import { ChatService } from './chat.service';
import { ConversationOwnershipService } from './conversation-ownership.service';
import {
  newConversation,
  T0,
  type OwnershipDb,
} from './conversation-ownership.test-fixtures';

/**
 * Serviços reais de envio da caixa (texto e mídia) sobre o banco do
 * testcontainer. Provedor, armazenamento de mídia e eventos são falsos (GK8):
 * nenhum teste manda WhatsApp de verdade. Complementa
 * `conversation-ownership.test-fixtures.ts` sem alterá-lo.
 */
export type ClaimEnv = {
  db: OwnershipDb;
  /** Canal EVOLUTION (o único provedor ligado) das conversas dos testes. */
  instanceId: string;
  chat: ChatService;
  media: ChatMediaService;
  events: { publish: Mock<(event: { type: string }) => Promise<void>> };
  wa: Record<string, Mock>;
  store: { put: Mock };
};

let providerSeq = 0;
/** Cada envio aceito devolve um id novo: `Message.providerMessageId` é único. */
const accepted = () => {
  providerSeq += 1;
  return Promise.resolve({
    providerMessageId: `wa-k1-${providerSeq}`,
    acceptedAt: T0,
  });
};

let channelSeq = 0;

export async function startClaimEnv(db: OwnershipDb): Promise<ClaimEnv> {
  channelSeq += 1;
  const channel = await db.prisma.channel.create({
    data: {
      name: 'Canal Evolution',
      provider: 'EVOLUTION',
      evolutionInstanceName: `inst-k1-${channelSeq}`,
    },
    select: { id: true },
  });
  const wa = {
    supportsInboxChatFor: vi.fn().mockReturnValue(true),
    sendChatText: vi.fn().mockImplementation(accepted),
    sendMedia: vi.fn().mockImplementation(accepted),
    sendWhatsAppAudio: vi.fn().mockImplementation(accepted),
    markMessageAsRead: vi.fn().mockResolvedValue(undefined),
    sendPresence: vi.fn().mockResolvedValue(undefined),
  };
  const events: ClaimEnv['events'] = {
    publish: vi.fn().mockResolvedValue(undefined),
  };
  const store = { put: vi.fn().mockResolvedValue(undefined) };
  const repo = new ChatRepository(db.prisma as never);
  const prisma = db.prisma as never;
  return {
    db,
    instanceId: channel.id,
    chat: new ChatService(repo, events as never, wa as never, prisma, db.audit),
    media: new ChatMediaService(
      store as never,
      repo,
      events as never,
      wa as never,
      new ConversationOwnershipService(prisma, db.audit, events as never, repo),
    ),
    events,
    wa,
    store,
  };
}

/** Conversa aberta no canal do ambiente, com telefone fictício; `over` sobrescreve. */
export const claimConversation = (env: ClaimEnv, over: object = {}) =>
  newConversation(env.db, {
    instanceId: env.instanceId,
    phoneE164: '+5592991110001',
    ...over,
  });

type Key = 'admin' | 'ana' | 'bia';

export const textReply = (env: ClaimEnv, id: string, by: Key) =>
  env.chat.sendReply(id, env.db.ids[by], { text: 'olá' });

const IMAGE = {
  buffer: Buffer.from('imagem'),
  originalname: 'foto.png',
  mimetype: 'image/png',
  size: 6,
} as Express.Multer.File;

export const mediaReply = (env: ClaimEnv, id: string, by: Key) =>
  env.media.sendMediaReply(id, env.db.ids[by], IMAGE);

export const messageCount = (env: ClaimEnv, id: string) =>
  env.db.prisma.message.count({ where: { conversationId: id } });

/** Os tipos de evento publicados, na ordem (espião de `ChatEventsService`). */
export const publishedTypes = (env: ClaimEnv): string[] =>
  env.events.publish.mock.calls.map(([event]) => event.type);

/** O erro que a promessa lançou (ou `null` se resolveu). */
export const rejectionOf = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: unknown) =>
      error as { status: number; code: string; detail: string },
  );
