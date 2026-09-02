import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { WhatsappInstancesRepository } from '../whatsapp-instances/whatsapp-instances.repository';
import { GozapInstancesService } from './gozap-instances.service';
import { QUEUE_NAMES } from '../queue/queue.constants';

/**
 * Reconciliador de conexão do GOZAP — o análogo do
 * `ConnectionReconcilerService` do Evolution, que pula todo canal sem
 * `evolutionInstanceName` e portanto nunca cobriu GOZAP.
 *
 * Por que precisa existir (incidente 2026-08-07): `GOZAP` é `sessionBased`, e o
 * roteador de envio exige `WhatsappConnectionEvent(state='open')` no banco.
 * As duas fontes possíveis desse evento estavam mortas para GOZAP — o webhook
 * (registrado numa URL interna e, mesmo entregue, com um nome de evento que
 * `processConnectionEvent` não reconhece) e o reconciliador do Evolution. Um
 * número pareado ficava permanentemente "desconectado" para o resto do
 * sistema, e todo envio parava em `WAITING_INSTANCE` sem uma linha de erro.
 *
 * Aqui o orgamind passa a PUXAR a verdade: `GET /instance/status` é sem efeito
 * colateral e não depende de webhook nenhum. Isso também cobre o caminho
 * inverso — a sessão cair (celular desligado, número banido) sem que ninguém
 * abra a página Canais.
 *
 * Cada canal roda no seu próprio try/catch: uma falha não pode abortar o loop.
 */
@Processor(QUEUE_NAMES.GOZAP_CONNECTION_RECONCILER, { concurrency: 1 })
export class GozapConnectionReconcilerProcessor extends WorkerHost {
  private readonly logger = new Logger(GozapConnectionReconcilerProcessor.name);

  constructor(
    private readonly repo: WhatsappInstancesRepository,
    private readonly gozap: GozapInstancesService,
  ) {
    super();
  }

  async process(): Promise<void> {
    const channels = (await this.repo.listActive()).filter(
      (c) => c.provider === 'GOZAP' && c.gozapInstanceToken,
    );
    if (channels.length === 0) return;

    let open = 0;
    let closed = 0;
    let failed = 0;

    for (const channel of channels) {
      try {
        const state = await this.gozap.reconcileConnection(channel.id);
        if (state === 'open') open++;
        else if (state === null) failed++;
        else closed++;
      } catch (err) {
        failed++;
        this.logger.warn(
          { err: (err as Error).message, channelId: channel.id },
          'gozap-connection-reconciler: erro inesperado num canal (seguindo para o próximo)',
        );
      }
    }

    this.logger.log(
      `gozap-connection-reconciler: total=${channels.length} open=${open} close=${closed} falhas=${failed}`,
    );
  }
}
