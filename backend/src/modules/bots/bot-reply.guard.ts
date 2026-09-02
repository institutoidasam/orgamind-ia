import type { ChannelProvider } from '@prisma/client';
import { isSessionProvider } from '../../schemas/contracts/channel-provider.schema';

export const BOT_SUPPORTED_KINDS = ['TEXT', 'IMAGE', 'AUDIO'] as const;

export type BotReplyGuardInput = {
  channelProvider: ChannelProvider;
  hasBot: boolean;
  botIsActive: boolean;
  contactOptedOut: boolean;
  botPausedAt: Date | null;
  direction: 'INBOUND' | 'OUTBOUND';
  kind: string;
};

export function shouldReply(i: BotReplyGuardInput): boolean {
  // Bots Dify respondem só em provider de SESSÃO (Baileys-web inbound) —
  // canais oficiais (Twilio/Zernio/Meta) não alimentam este caminho ainda.
  if (!isSessionProvider(i.channelProvider)) return false;
  if (!i.hasBot || !i.botIsActive) return false;
  if (i.contactOptedOut) return false;
  if (i.botPausedAt !== null) return false;
  if (i.direction !== 'INBOUND') return false;
  return (BOT_SUPPORTED_KINDS as readonly string[]).includes(i.kind);
}
