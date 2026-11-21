import type { ChannelProvider } from '@/features/whatsapp/api';
import { DISABLED_PROVIDER_LABEL } from '@/features/whatsapp/disabled-provider';

/** Aviso de canal de integração desligada (GC11). */
export function providerDisabledNotice(provider: ChannelProvider): string {
  return `Este número usa uma integração desligada (${DISABLED_PROVIDER_LABEL[provider]}). Para responder, conecte um número Evolution em Conexões.`;
}
