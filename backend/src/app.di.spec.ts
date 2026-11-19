import { expect, it } from 'vitest';
import { ModuleRef } from '@nestjs/core';
import { describeBootGraph } from '../test/di-boot';

/**
 * O boot da API com o env SÓ da Evolution e com o env de sobra de provedores
 * desligados (GoZap completo, Zernio parcial). Ciclo de módulos ou provider
 * fora de escopo não aparece em `tsc` nem em teste unitário (todos usam
 * `new`): só no boot. Aqui o `AppModule` real compila (Prisma, Redis e filas
 * são dublês).
 */
describeBootGraph(
  'AppModule',
  async () => (await import('./app.module.js')).AppModule,
  (getModule) => {
    it('resolve o DisabledChannelsService e o CampaignsService sob demanda (ModuleRef strict:false)', async () => {
      const { DisabledChannelsService } =
        await import('./modules/whatsapp-providers/disabled-channels.service.js');
      const { CampaignsService } =
        await import('./modules/campaigns/campaigns.service.js');
      const app = getModule();

      expect(app.get(DisabledChannelsService, { strict: false })).toBeDefined();
      // A resolução que o serviço faz em `completeCampaigns` (sem injetar, por
      // causa do ciclo CampaignsModule → TemplatesModule → WhatsappProvidersModule).
      const campaigns = app
        .get(ModuleRef)
        .get(CampaignsService, { strict: false });
      expect(typeof campaigns.maybeCompleteCampaign).toBe('function');
    });
  },
);
