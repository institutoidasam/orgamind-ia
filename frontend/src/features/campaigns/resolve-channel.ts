/**
 * T15 — A REGRA ÚNICA PARA ACHAR O CANAL DE UMA CAMPANHA (todo provedor).
 *
 * `GET /whatsapp/instances` (`useInstances()`) só devolve canais EVOLUTION
 * (whatsapp-instances.repository.ts). O cabeçalho de progresso da campanha
 * (T8) e o passo final do assistente (T11) resolviam o canal da campanha por
 * ali — então para GOZAP (o canal de PRODUÇÃO), ZERNIO, TWILIO e META o canal
 * buscado ficava `undefined` PARA SEMPRE: as duas telas mostravam "Canal não
 * encontrado — verifique em Canais" e bloqueavam o envio mesmo com o canal
 * saudável e com quota sobrando.
 *
 * `GET /whatsapp/providers` (`useProviders()`) já lista os canais de TODO
 * provedor configurado (e já é a query que o seletor de canal do assistente
 * usa). Este módulo é a ÚNICA regra de como interpretar essa query nas DUAS
 * telas que precisam do canal da campanha — para as duas nunca divergirem de
 * novo sobre o que "canal carregando" ou "canal não encontrado" significam.
 */
import type { ChannelSummary, ProvidersResponse } from '@/features/whatsapp/api';

/** O recorte de `useProviders()` (UseQueryResult) que este helper precisa. */
export type ProvidersQueryState = {
  data: ProvidersResponse | undefined;
  isPending: boolean;
  isError: boolean;
};

export type CampaignChannelResolution = {
  state: 'loading' | 'error' | 'missing' | 'found';
  canal?: ChannelSummary;
  /**
   * true quando o resultado veio do CACHE porque a busca mais recente
   * falhou (refetch error) — o operador vê um aviso pequeno de "pode estar
   * desatualizado", mas o envio NÃO é bloqueado por isso.
   */
  stale?: boolean;
};

/**
 * Fix round 1 (#1, review Opus) — `isError` sozinho não distingue duas
 * situações bem diferentes do TanStack Query:
 *
 *  - `isLoadingError`: a busca INICIAL falhou — não existe NENHUM dado, nem
 *    velho. Aí sim é `error` de verdade: não há nada para mostrar.
 *  - `isRefetchError`: já existia um dado bom (de uma busca anterior — ex.:
 *    o cabeçalho poll a cada 30s) e só a busca MAIS RECENTE falhou. O
 *    TanStack mantém o `data` anterior nesse caso — travar o envio aqui
 *    (como a v1 desta função fazia) desligava "Enviar próximo lote" por causa
 *    de UM blip de rede, com um canal perfeitamente bom em cache.
 *
 * Este helper não tem acesso direto a `isLoadingError`/`isRefetchError` (o
 * tipo `ProvidersQueryState` é um recorte mínimo, não o `UseQueryResult`
 * inteiro) — mas a mesma distinção sai de `isError` + a PRESENÇA de `data`:
 * sem dado nenhum é `isLoadingError`; com dado, é `isRefetchError`.
 *
 * `error` (sem dado) NUNCA vira "Canal não encontrado" — são causas
 * diferentes (rede caída vs. canal que realmente não existe) e pedem
 * respostas diferentes do operador.
 */
export function resolveCampaignChannel(
  providersQuery: ProvidersQueryState,
  defaultInstanceId: string,
): CampaignChannelResolution {
  const { data } = providersQuery;

  if (providersQuery.isError && data == null) return { state: 'error' };
  if (providersQuery.isPending || data == null) return { state: 'loading' };

  // A partir daqui SEMPRE há `data` (o `data == null` acima já saiu) —
  // resolve normalmente a partir dele, mesmo que a busca mais recente tenha
  // falhado (isRefetchError).
  const stale = providersQuery.isError;
  const canal = data.providers
    .flatMap((p) => p.channels)
    .find((c) => c.id === defaultInstanceId);

  // Fix round 1 (minor, review Opus) — `dailySendLimit` é OPCIONAL no
  // contrato; sem ele `capDeHoje`/`quotaRestante` (channel-quota.ts) não têm
  // como saber se o canal tem QUALQUER quota, e a armadilha do "propõe 1"
  // (★ NUNCA UM CAMPO COM 0) voltaria a valer para "0 por ignorância". Trata
  // como "não encontrado" de propósito — nunca "found" sem número.
  if (!canal || canal.dailySendLimit === undefined) {
    return stale ? { state: 'missing', stale: true } : { state: 'missing' };
  }
  return stale ? { state: 'found', canal, stale: true } : { state: 'found', canal };
}
