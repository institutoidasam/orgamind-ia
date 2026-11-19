import type { ChannelProvider } from '@prisma/client';
import { PROVIDER_DISPLAY_NAME } from '../config/enabled-providers';
import { DomainError } from './domain.error';

export const PROVIDER_DISABLED_CODE = 'channel.provider_disabled';

/**
 * Canal de provedor desligado (só a Evolution está ligada). 409 no envio
 * síncrono; 422 quando o pedido é criar canal de provedor desligado.
 * Mensagem pt-BR para o usuário.
 */
export class ChannelProviderDisabledError extends DomainError {
  constructor(provider: ChannelProvider, status: 409 | 422 = 409) {
    super({
      code: PROVIDER_DISABLED_CODE,
      message: `Este número usa uma integração desligada (${PROVIDER_DISPLAY_NAME[provider]}).`,
      status,
      detail: `provider=${provider}`,
    });
  }
}
