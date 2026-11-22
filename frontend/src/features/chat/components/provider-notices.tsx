import type { ChannelProvider } from '@/features/whatsapp/api';
import { PROVIDER_LABEL } from '@/features/whatsapp/provider-scope';
import { providerDisabledNotice } from './provider-notice-text';

const MUTED = { color: 'var(--foreground-muted)' };

/**
 * Avisos de provedor acima do campo do compositor (canal desligado, info do
 * provedor ainda carregando, canal sem chat). Extraído de `message-composer.tsx`
 * sem mudar marcação nem testids.
 */
export function ProviderNotices({ provider, disabledProvider, noticeId, infoUnknown, restricted }: {
  provider: ChannelProvider | undefined; disabledProvider: ChannelProvider | null; noticeId: string;
  infoUnknown: boolean; restricted: boolean;
}) {
  return (
    <>
      {disabledProvider ? (
        <p id={noticeId} data-testid="provider-disabled-banner" className="px-4 pt-2 text-xs" style={MUTED}>
          {providerDisabledNotice(disabledProvider)}
        </p>
      ) : null}
      {infoUnknown ? (
        <p data-testid="provider-traits-loading" className="px-4 pt-2 text-xs" style={MUTED}>
          Carregando…
        </p>
      ) : null}
      {restricted && provider ? (
        <p data-testid="provider-not-supported-banner" className="px-4 pt-2 text-xs" style={MUTED}>
          Respostas por este canal ainda não estão disponíveis — o envio de texto livre por {PROVIDER_LABEL[provider]} será liberado em breve.
        </p>
      ) : null}
    </>
  );
}
