import { Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { Roles } from '../auth/decorators/roles.decorator';
import { QUEUE_NAMES } from '../queue/queue.constants';
import { ZernioSyncRunsService } from './zernio-sync-runs.service';

export type ZernioSyncEnqueued = {
  runId: string;
  status: string;
  /** false => já havia um sync em curso; devolvemos o run existente. */
  enqueued: boolean;
};

export type ZernioSyncStatus = {
  runId: string | null;
  /** PENDING | RUNNING | PAUSED | SUCCEEDED | FAILED | IDLE (nunca rodou). */
  status: string;
  total: number;
  processed: number;
  imported: number;
  failed: number;
  error: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
};

/**
 * Gatilho do sync do inbox do Zernio — agora ASSÍNCRONO.
 *
 * Mora no ChatModule, e não no WhatsappProvidersController (onde as outras rotas
 * `/whatsapp/*` vivem), por uma razão de dependência: o sync precisa do
 * `ChatIngestService`, e o ChatModule já importa o WhatsappProvidersModule — o
 * contrário criaria um ciclo entre os dois módulos.
 *
 * POR QUE DEIXOU DE SER SÍNCRONO (o comentário anterior defendia o contrário):
 * a versão síncrona percorria ~100 conversas dentro da request do operador — uma
 * requisição ao Zernio por conversa. O balde do Zernio é de 60 req/min: na 61ª
 * conversa vinha 429, a exceção subia até aqui e o operador levava **HTTP 500**,
 * com ZERO conversas importadas, depois de encarar uma tela travada por minutos.
 *
 * O argumento antigo ("o operador quer o RESULTADO, não um 'enfileirado'")
 * continua de pé — e é atendido pelo `GET .../sync-inbox/status`: o front
 * acompanha o progresso ("42 de 100 conversas…") e mostra o resultado final. O
 * que mudou é que nada disso depende de uma request de 3 minutos sobreviver.
 */
@Controller('whatsapp/channels')
export class ZernioInboxSyncController {
  constructor(
    private readonly runs: ZernioSyncRunsService,
    @InjectQueue(QUEUE_NAMES.ZERNIO_INBOX_SYNC) private readonly queue: Queue,
  ) {}

  @Roles('ADMIN')
  @Post(':id/sync-inbox')
  @HttpCode(202) // Accepted: o trabalho foi ACEITO, não concluído.
  async syncInbox(@Param('id') id: string): Promise<ZernioSyncEnqueued> {
    const { run, created } = await this.runs.startOrReuse(id);

    // Só enfileira se o run é NOVO. Duplo clique / F5 reaproveitam o run em
    // curso: dois syncs no mesmo canal dobrariam o consumo do balde.
    if (created) {
      await this.queue.add(
        'sync-inbox-manual',
        { runId: run.id, channelId: id },
        { jobId: `zernio-sync-run-${run.id}` },
      );
    }

    return { runId: run.id, status: run.status, enqueued: created };
  }

  @Roles('ADMIN')
  @Get(':id/sync-inbox/status')
  async syncInboxStatus(@Param('id') id: string): Promise<ZernioSyncStatus> {
    const run = await this.runs.latest(id);
    // Canal que nunca sincronizou não é erro — a tela só não tem o que mostrar.
    if (!run) {
      return {
        runId: null,
        status: 'IDLE',
        total: 0,
        processed: 0,
        imported: 0,
        failed: 0,
        error: null,
        startedAt: null,
        finishedAt: null,
      };
    }
    return {
      runId: run.id,
      status: run.status,
      total: run.totalConversations,
      processed: run.processedConversations,
      imported: run.importedMessages,
      failed: run.failedConversations,
      error: run.error,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
    };
  }
}
