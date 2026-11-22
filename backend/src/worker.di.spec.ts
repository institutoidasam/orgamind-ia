import { expect, it } from 'vitest';
import { getQueueToken } from '@nestjs/bullmq';
import { describeBootGraph } from '../test/di-boot';

/**
 * ★ O GRAFO DE DI DO WORKER RESOLVE?
 *
 * Um ciclo de módulos (ou um provider que o escopo não resolve) **não é pego pelo
 * `tsc` nem por nenhum teste unitário** — todos eles constroem os serviços com
 * `new`. O erro só aparece no BOOT do worker: o processo morre, e o efeito em
 * produção é que NENHUMA mensagem sai. Numa campanha eleitoral, no dia do
 * disparo, esse é o pior desfecho possível — e quem o descobriria seria o cliente.
 *
 * Roda nos dois ambientes de boot (só Evolution; Evolution + env de sobra de
 * GoZap/Zernio). O `ZernioBroadcastSendService`/`ZernioBroadcastPollService`
 * SAÍRAM do WorkerModule (B8): só os processors removidos os injetavam; os
 * serviços seguem no `WhatsappProvidersModule` (D3), inativos.
 *
 * Prisma e Redis são dublês: o que se testa aqui é o GRAFO, não a rede.
 */
describeBootGraph(
  'WorkerModule',
  async () => (await import('./worker.module.js')).WorkerModule,
  (getModule) => {
    it('resolve as 8 filas de provedor desligado e o purge do boot não cai em failed', async () => {
      const { DISABLED_PROVIDER_QUEUES, purgeDisabledProviderRepeatables } =
        await import('./modules/queue/disabled-provider-queues.js');
      const worker = getModule();

      // O mesmo `app.get(getQueueToken(name))` do `worker.ts`.
      const { removed, failed } = await purgeDisabledProviderRepeatables(
        (name) => worker.get(getQueueToken(name), { strict: false }),
      );

      expect(failed).toEqual([]);
      expect(Object.keys(removed)).toEqual([...DISABLED_PROVIDER_QUEUES]);
    });

    it('injeta as filas do broadcast no CampaignsService e as portas no processor da equipe', async () => {
      const { CampaignsService } =
        await import('./modules/campaigns/campaigns.service.js');
      const { TeamWhatsappSendProcessor } =
        await import('./modules/team-whatsapp/team-whatsapp-send.processor.js');
      const worker = getModule();

      // As filas são OPCIONAIS no construtor (specs históricos constroem o
      // serviço posicionalmente); sem esta asserção o cancelamento viraria um
      // no-op silencioso em produção.
      const campaigns = worker.get(CampaignsService);
      for (const dep of ['broadcastDispatchQueue', 'broadcastCancelQueue']) {
        expect(Reflect.get(campaigns, dep) as unknown).toBeDefined();
      }
      // O processor do envio da equipe recebe o repositório e a porta do estado
      // ao vivo por PROPRIEDADE (o construtor está no limite de parâmetros).
      const sender = worker.get(TeamWhatsappSendProcessor);
      for (const dep of ['repo', 'liveState']) {
        expect(Reflect.get(sender, dep) as unknown).toBeDefined();
      }
    });
  },
);
