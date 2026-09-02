import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { TemplatesService } from './templates.service';
import { ZernioTemplateService } from '../whatsapp-providers/zernio-template.service';
import { QUEUE_NAMES } from '../queue/queue.constants';

/**
 * ZC — reconciliação do catálogo de templates do Zernio.
 *
 * **É uma REDE DE SEGURANÇA, não o mecanismo principal.** O caminho normal é o
 * webhook `whatsapp.template.status_updated`, que atualiza o status NA HORA
 * (ver `WebhooksService.processTemplateStatus`). Este job existe para os casos
 * em que o webhook não chega: entrega em dead-letter depois de ~51h de retries,
 * template criado direto no painel da Meta/Zernio, ou canal novo cujo catálogo
 * ainda não foi importado.
 *
 * O tick é de **1 hora**, e o espaçamento é a decisão de projeto: o balde do
 * Zernio é de 60 req/min POR CHAVE e é o **mesmo balde do ENVIO**. Um sync
 * agressivo (o approval-sync da Twilio roda a cada 2 min, porque lá não existe
 * webhook de aprovação e a Twilio tem outro limite) competiria com a campanha
 * pela vazão que ela precisa. Aqui, temos webhook — então polling frequente
 * seria pagar caro por um sinal que já chega de graça.
 *
 * Custo por rodada: 1 requisição por canal ZERNIO ativo.
 */
@Processor(QUEUE_NAMES.ZERNIO_TEMPLATE_SYNC, { concurrency: 1 })
export class ZernioTemplateSyncProcessor extends WorkerHost {
  private readonly logger = new Logger(ZernioTemplateSyncProcessor.name);

  constructor(
    private readonly templates: TemplatesService,
    private readonly zernio: ZernioTemplateService,
  ) {
    super();
  }

  async process(): Promise<void> {
    // Deploy sem credencial Zernio → nada a reconciliar (e sem 401 de hora em
    // hora no log).
    if (!this.zernio.configured) return;

    // Uma falha lança e o BullMQ registra o tick como falho — a próxima rodada
    // tenta de novo. Engolir o erro aqui esconderia um catálogo que parou de
    // sincronizar.
    const { synced, skipped } = await this.templates.syncFromZernio();
    this.logger.log(
      `zernio-template-sync: synced=${synced} skipped=${skipped}`,
    );
  }
}
