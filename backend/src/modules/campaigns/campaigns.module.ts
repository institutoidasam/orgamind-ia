import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { CampaignsService } from './campaigns.service';
import { CampaignsController } from './campaigns.controller';
import { CampaignsRepository } from './campaigns.repository';
import { TemplatesModule } from '../templates/templates.module';
import { SegmentsModule } from '../segments/segments.module';
import { WhatsappInstancesModule } from '../whatsapp-instances/whatsapp-instances.module';
import { QUEUE_NAMES } from '../queue/queue.constants';

@Module({
  imports: [
    TemplatesModule,
    SegmentsModule,
    WhatsappInstancesModule,
    // ★ K1/K5 (auditoria 2026-08-19) — AQUI HAVIA TRÊS `registerQueue` PELADOS.
    //
    // Um `registerQueue` sem `defaultJobOptions` cria uma SEGUNDA instância de
    // Queue para o mesmo nome e SOMBREIA a configuração do QueueModule global.
    // Era essa instância que o CampaignsService injetava — a que enfileira TODO
    // envio de campanha. O teste `campaigns.module.queues.spec.ts` mediu: as
    // três filas chegavam ao serviço com `defaultJobOptions` UNDEFINED.
    //
    // O que isso custava:
    //  • ENVIO — sem `attempts`, o caminho retryável do worker (releaseClaim
    //    SENDING→QUEUED + relançar, contando com a retentativa do BullMQ)
    //    deixava a mensagem QUEUED PARA SEMPRE, sem job nenhum. Nenhum sweeper
    //    cobre esse estado, `countInFlight` a conta como em voo, e a campanha
    //    ficava "Em execução" eternamente com o redisparo recusando por I10.
    //  • ENVIO — sem `removeOnComplete`/`removeOnFail`, uma campanha de 13.400
    //    pessoas deixava 13.400 jobs permanentes no MESMO Redis dos locks, do
    //    pacing e dos contadores de tier.
    //  • KILL-SWITCH do broadcast — `attempts: 5` é o mais teimoso da casa de
    //    propósito: ele é o que PARA um disparo em voo quando a conta é
    //    bloqueada ou o template pausado. Sombreado, desistia na primeira
    //    tentativa, e desistir aqui é deixar o Zernio continuar mandando.
    //
    // As duas filas cuja política global está CERTA (envio e cancelamento) não
    // são mais registradas aqui: `@InjectQueue` as resolve do QueueModule
    // @Global, que é o mesmo padrão já adotado pelo ChatModule depois do
    // mesmo defeito. Sobra a exceção deliberada, logo abaixo.

    // ZB — o caminho de BROADCAST do Zernio. Só a FILA entra aqui (não o módulo
    // de provedores): assim o CampaignsModule continua sem depender dele, e é o
    // WhatsappProvidersModule que importa este — sem ciclo.
    //
    // ⚠️ A ÚNICA fila que segue com política PRÓPRIA, e ela DIVERGE do global de
    // propósito: `attempts: 1`, contra os `attempts: 2` do QueueModule.
    //
    // ⚠️⚠️ DIVERGÊNCIA CONHECIDA, E A AUTORIDADE É O `queue.module.ts`.
    // Lá esta mesma fila é registrada com `attempts: 2` e um comentário que
    // argumenta o CONTRÁRIO do que está escrito logo abaixo ("uma retentativa
    // cobre a falha honesta").
    //
    // O `whatsapp-providers.module.ts` a registra uma TERCEIRA vez — e é a
    // instância DE LÁ que o `ZernioBroadcastSendService` injeta para
    // reenfileirar os lotes excedentes do teto de 24h. Até a revisão de
    // integração (I16) aquele registro era PELADO, o que zerava `attempts` por
    // acidente e ainda vazava jobs no Redis; hoje ele declara os MESMOS
    // `attempts: 1` daqui, com a mesma justificativa e com a limpeza junto —
    // ou seja, os dois injetores concordam, e o que sobra é a divergência
    // contra o global.
    //
    // Unificar em 2 exige antes tornar `zernio-broadcast-send.service.ts`
    // idempotente; é decisão de quem for mexer no `queue.module.ts`, e vale
    // para os três lugares de uma vez. `campaigns.module.queues.spec.ts` monta
    // os DOIS módulos junto com o global e prende os três números.
    // NENHUM endpoint de broadcast do Zernio aceita `Idempotency-Key`. Se o
    // `POST /broadcasts/{id}/send` for aceito e a resposta se perder (timeout),
    // a retentativa NÃO é neutra: ela redispara o LOTE INTEIRO — as mesmas
    // milhares de pessoas recebendo duas vezes, num número que já teve display
    // name reprovado pela Meta. Isso já valia hoje, mas por ACIDENTE (o
    // registro pelado zerava `attempts`); aqui passa a estar escrito, com a
    // limpeza do Redis junto. Para subir para 2 seria preciso antes tornar o
    // caminho de `zernio-broadcast-send.service.ts` idempotente — o `catch` que
    // devolve o lote a QUEUED aposta num `cancelBroadcast` best-effort que
    // falha em silêncio exatamente quando o Zernio está fora.
    BullModule.registerQueue({
      name: QUEUE_NAMES.ZERNIO_BROADCAST_DISPATCH,
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: { age: 86400, count: 100 },
        removeOnFail: { age: 7 * 86400 },
      },
    }),
  ],
  controllers: [CampaignsController],
  providers: [CampaignsService, CampaignsRepository],
  exports: [CampaignsService, CampaignsRepository],
})
export class CampaignsModule {}
