import { describe, it, expect } from 'vitest';
import { resolveCampaignChannel } from './resolve-channel';
import type { ProvidersQueryState } from './resolve-channel';

/**
 * T15 — A REGRA ÚNICA para achar o canal de uma campanha.
 *
 * A causa do bug: `useInstances()` (GET /whatsapp/instances) só devolve
 * canais EVOLUTION. O cabeçalho de progresso e o passo final do assistente
 * resolviam o canal por ali — então para GOZAP (o canal de PRODUÇÃO),
 * ZERNIO, TWILIO e META o canal buscado ficava `undefined` para sempre, e o
 * envio ficava bloqueado com "Canal não encontrado" mesmo com o canal são.
 * `useProviders()` (GET /whatsapp/providers) lista canais de TODO provedor
 * configurado — este helper decide, de um jeito só, o que fazer com essa
 * query nas DUAS telas.
 */
describe('resolveCampaignChannel', () => {
  const GOZAP_CHANNEL = {
    id: 'inst1',
    name: 'robo',
    phoneE164: '+559231550101',
    isActive: true,
    isDefault: true,
    provider: 'GOZAP' as const,
    dailySendLimit: 500,
    sentToday: 120,
    sentTodayResetAt: '2026-08-24T13:00:00.000Z',
  };

  const EVOLUTION_CHANNEL = {
    id: 'ev1',
    name: 'principal',
    phoneE164: '+5511999999999',
    isActive: true,
    isDefault: true,
    provider: 'EVOLUTION' as const,
    dailySendLimit: 200,
    sentToday: 10,
    sentTodayResetAt: '2026-08-24T13:00:00.000Z',
  };

  function query(over: Partial<ProvidersQueryState>): ProvidersQueryState {
    return { data: undefined, isPending: false, isError: false, ...over };
  }

  it('erro na query → state "error" (nunca finge que o canal não existe)', () => {
    const r = resolveCampaignChannel(
      query({ isError: true, isPending: false }),
      'inst1',
    );
    expect(r).toEqual({ state: 'error' });
  });

  it('ainda carregando (sem erro) → state "loading"', () => {
    const r = resolveCampaignChannel(
      query({ isPending: true, data: undefined }),
      'inst1',
    );
    expect(r).toEqual({ state: 'loading' });
  });

  it('carregou, mas o id da campanha não está em NENHUM provedor → state "missing"', () => {
    const r = resolveCampaignChannel(
      query({ data: { providers: [{ provider: 'GOZAP', traits: {} as never, capabilities: [], channels: [] }] } }),
      'inst1',
    );
    expect(r).toEqual({ state: 'missing' });
  });

  it('acha um canal GOZAP (o caso hoje travado em produção) → state "found"', () => {
    const r = resolveCampaignChannel(
      query({
        data: {
          providers: [
            { provider: 'GOZAP', traits: {} as never, capabilities: [], channels: [GOZAP_CHANNEL] },
          ],
        },
      }),
      'inst1',
    );
    expect(r).toEqual({ state: 'found', canal: GOZAP_CHANNEL });
  });

  it('acha um canal EVOLUTION normalmente (não regride o caso já funcionando)', () => {
    const r = resolveCampaignChannel(
      query({
        data: {
          providers: [
            { provider: 'EVOLUTION', traits: {} as never, capabilities: [], channels: [EVOLUTION_CHANNEL] },
          ],
        },
      }),
      'ev1',
    );
    expect(r).toEqual({ state: 'found', canal: EVOLUTION_CHANNEL });
  });

  it('procura em TODOS os grupos de provedor, não só no primeiro', () => {
    const r = resolveCampaignChannel(
      query({
        data: {
          providers: [
            { provider: 'EVOLUTION', traits: {} as never, capabilities: [], channels: [] },
            { provider: 'GOZAP', traits: {} as never, capabilities: [], channels: [GOZAP_CHANNEL] },
          ],
        },
      }),
      'inst1',
    );
    expect(r).toEqual({ state: 'found', canal: GOZAP_CHANNEL });
  });

  it('acha mesmo um canal INATIVO — quem decide o que fazer com isso é quem consome (aviso de canal inativo)', () => {
    const inativo = { ...GOZAP_CHANNEL, isActive: false };
    const r = resolveCampaignChannel(
      query({
        data: { providers: [{ provider: 'GOZAP', traits: {} as never, capabilities: [], channels: [inativo] }] },
      }),
      'inst1',
    );
    expect(r).toEqual({ state: 'found', canal: inativo });
  });

  /**
   * Fix round 1 (#1, review Opus) — um REFETCH que falha (o cabeçalho poll a
   * cada 30s) NÃO pode travar o envio se já existe um canal bom em cache: no
   * TanStack Query isso é `isRefetchError` (isError === true, mas `data`
   * ainda é o último valor bem-sucedido) — diferente de `isLoadingError`
   * (isError === true e NUNCA houve dado nenhum). Resolve normalmente a
   * partir do cache e só marca `stale: true` para a tela avisar, sem bloquear.
   */
  it('erro de REFETCH com um canal GOZAP em cache → continua "found" (com stale: true), não trava o envio', () => {
    const r = resolveCampaignChannel(
      query({
        isError: true,
        data: {
          providers: [
            { provider: 'GOZAP', traits: {} as never, capabilities: [], channels: [GOZAP_CHANNEL] },
          ],
        },
      }),
      'inst1',
    );
    expect(r).toEqual({ state: 'found', canal: GOZAP_CHANNEL, stale: true });
  });

  it('erro de refetch e o canal não está no cache → "missing" (com stale: true), nunca finge "found"', () => {
    const r = resolveCampaignChannel(
      query({
        isError: true,
        data: { providers: [{ provider: 'GOZAP', traits: {} as never, capabilities: [], channels: [] }] },
      }),
      'inst1',
    );
    expect(r).toEqual({ state: 'missing', stale: true });
  });

  it('erro SEM dado nenhum em cache (isLoadingError) → "error" de verdade', () => {
    const r = resolveCampaignChannel(
      query({ isError: true, data: undefined }),
      'inst1',
    );
    expect(r).toEqual({ state: 'error' });
  });

  /**
   * Fix round 1 (minor, review Opus) — `dailySendLimit` é OPCIONAL no
   * contrato (channelSummarySchema). Um canal "encontrado" sem ele reabriria
   * a armadilha do "propõe 1" (ver channel-quota.ts, ★ NUNCA UM CAMPO COM 0):
   * `capDeHoje`/`quotaRestante` não têm como saber se ele tem QUALQUER quota.
   * Trata como "não encontrado" de propósito — nunca "found" sem número.
   */
  it('canal presente mas SEM dailySendLimit (contrato incompleto) → "missing", nunca "found" sem quota', () => {
    const semQuota = { ...GOZAP_CHANNEL, dailySendLimit: undefined };
    const r = resolveCampaignChannel(
      query({
        data: { providers: [{ provider: 'GOZAP', traits: {} as never, capabilities: [], channels: [semQuota] }] },
      }),
      'inst1',
    );
    expect(r).toEqual({ state: 'missing' });
  });
});
