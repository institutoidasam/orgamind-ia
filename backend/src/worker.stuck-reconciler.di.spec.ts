import { expect, it } from 'vitest';
import { getQueueOptionsToken, getQueueToken } from '@nestjs/bullmq';
import { describeBootGraph } from '../test/di-boot';

/**
 * O verificador de presos da equipe (Lote H) resolve no grafo REAL do worker?
 * Os testes unitários constroem o serviço com `new`; um provider fora de escopo
 * só apareceria no boot, e o worker inteiro morreria. Prisma, Redis e as filas
 * são dublês (ver `test/di-boot.ts`): o que se prova é o GRAFO.
 */
describeBootGraph(
  'WorkerModule (verificador de presos)',
  async () => (await import('./worker.module.js')).WorkerModule,
  (getModule) => {
    it('WorkerModule resolve TeamWhatsappStuckProcessor e TeamStuckReconcilerService com as dependências', async () => {
      const { TeamWhatsappStuckProcessor } =
        await import('./modules/team-whatsapp/team-whatsapp-stuck.processor.js');
      const { TeamStuckReconcilerService } =
        await import('./modules/team-whatsapp/team-stuck-reconciler.service.js');
      const { QUEUE_NAMES } =
        await import('./modules/queue/queue.constants.js');
      const worker = getModule();

      const reconciler = worker.get(TeamStuckReconcilerService);
      expect(
        Reflect.get(worker.get(TeamWhatsappStuckProcessor), 'reconciler'),
      ).toBe(reconciler);
      for (const dep of ['repo', 'chat', 'audit']) {
        expect(Reflect.get(reconciler, dep) as unknown).toBeDefined();
      }
      // A fila consultada é a do ENVIO: com outra fila todo job pareceria
      // ausente e todo destinatário parado viraria "perdido".
      expect(Reflect.get(reconciler, 'queue')).toBe(
        worker.get(getQueueToken(QUEUE_NAMES.TEAM_WHATSAPP_SEND), {
          strict: false,
        }),
      );
    });

    it('fila do verificador registrada com attempts 1 e retenção curta (DH4)', async () => {
      const { QUEUE_NAMES } =
        await import('./modules/queue/queue.constants.js');
      const options = getModule().get<{ defaultJobOptions?: unknown }>(
        getQueueOptionsToken(QUEUE_NAMES.TEAM_WHATSAPP_STUCK_RECONCILER),
        { strict: false },
      );

      expect(options.defaultJobOptions).toEqual({
        attempts: 1,
        removeOnComplete: { age: 3600, count: 12 },
        removeOnFail: { age: 86400 },
      });
    });
  },
);
