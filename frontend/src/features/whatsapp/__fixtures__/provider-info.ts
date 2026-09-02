import type { ChannelProvider, ProviderInfo } from '../api';

/**
 * Traits + capabilities REAIS que o backend expõe hoje para os 4 providers
 * (GET /whatsapp/providers) — espelha `PROVIDER_TRAITS` (channel-provider.schema.ts)
 * e o `.profile` declarado por cada adapter em
 * backend/src/modules/whatsapp-providers/adapters/*.ts.
 *
 * Fixture única compartilhada pelos specs do composer (antes duplicada em 4
 * arquivos como `TRAITS_BY_PROVIDER`, só com traits — Minor registrado na F0).
 * Mudar um valor aqui é uma decisão sobre o CONTRATO do backend, não sobre
 * comportamento do composer: se um destes providers ganhar/perder uma
 * capacidade de verdade, os specs do composer devem refletir a mudança real,
 * não inventar uma.
 */
export const PROVIDER_INFO: Record<ChannelProvider, ProviderInfo> = {
  EVOLUTION: {
    traits: { official: false, sessionBased: true, sessionWindow: false },
    capabilities: [
      'campaignSend', 'sessionLifecycle', 'inboxChat', 'chatMedia',
      'contactTools', 'labels', 'historySync',
    ],
  },
  TWILIO: {
    traits: { official: true, sessionBased: false, sessionWindow: true },
    capabilities: ['campaignSend', 'statusPolling', 'inboxChat'],
  },
  ZERNIO: {
    traits: { official: true, sessionBased: false, sessionWindow: true },
    capabilities: ['campaignSend', 'inboxChat'],
  },
  META: {
    traits: { official: true, sessionBased: false, sessionWindow: false },
    capabilities: ['campaignSend'],
  },
  // GOZAP (F-A, Task 1): só o enum + traits existem até aqui — nenhum adapter
  // está registrado ainda, então o backend real não declara capacidade
  // nenhuma para este provider. `capabilities: []` reflete isso; NÃO copiar as
  // da EVOLUTION até uma tarefa futura da F-A/F-B realmente implementar o
  // adapter e o profile dele.
  GOZAP: {
    traits: { official: false, sessionBased: true, sessionWindow: false },
    capabilities: [],
  },
};
