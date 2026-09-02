import { Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Queue } from 'bullmq';
import { Roles } from '../auth/decorators/roles.decorator';
import { QUEUE_NAMES } from '../queue/queue.constants';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { INDETERMINATE_DELIVERY_MARK } from './zernio-broadcast-send.service';

export type ZernioBroadcastSyncEnqueued = { enqueued: boolean };

/** Uma pessoa que ficou na dúvida: pode ter recebido, pode não ter. */
export type ZernioIndeterminateContact = {
  messageId: string;
  contactId: string | null;
  name: string | null;
  phoneE164: string | null;
  sentAt: Date | null;
  /** O id do disparo NO ZERNIO — é ele que se procura no painel. */
  zernioBroadcastId: string | null;
  zernioBroadcastName: string | null;
};

export type ZernioIndeterminateDeliveries = {
  total: number;
  comoAgir: string;
  contacts: ZernioIndeterminateContact[];
};

/**
 * O texto do remédio. Ele descreve SÓ o que o produto de fato oferece — a versão
 * anterior desta instrução vivia num log e mandava "redisparar a campanha",
 * que para estas linhas é um no-op silencioso.
 */
const COMO_AGIR =
  'Procure cada disparo abaixo no painel do Zernio. Se ele EXISTE lá, as mensagens saíram e ' +
  'não há nada a fazer — o webhook vai corrigir o status sozinho. Se NÃO existe, ninguém ' +
  'recebeu: crie uma campanha nova com os contatos desta lista. NÃO use "Disparar novamente" ' +
  'nesta campanha — estas linhas contam como enviadas, então o modo padrão as ignora e o modo ' +
  '"para todos" reenviaria para a audiência inteira.';

/**
 * O gatilho manual do espelho de disparos do Zernio.
 *
 * ASSÍNCRONO por decisão, e pela mesma razão que o sync do inbox deixou de ser
 * síncrono: a listagem pode ter várias páginas, cada página é uma requisição ao
 * Zernio, e o balde é de 60 req/min. Fazer isso dentro da request do operador
 * termina em 429 → HTTP 500 na cara dele. Aqui ele recebe 202 e o tick de 15 min
 * (ou este job) faz o trabalho.
 *
 * `jobId` fixo: dois cliques (ou um F5) não podem virar dois jobs — dobrariam o
 * consumo do balde que o ENVIO usa.
 */
@ApiTags('whatsapp')
@Controller('whatsapp/zernio')
export class ZernioBroadcastSyncController {
  constructor(
    @InjectQueue(QUEUE_NAMES.ZERNIO_BROADCAST_SYNC)
    private readonly queue: Queue,
    private readonly prisma: PrismaService,
  ) {}

  @Roles('ADMIN')
  @ApiOperation({
    summary: 'Força o espelho dos disparos (broadcasts) do Zernio agora',
  })
  @Post('sync-broadcasts')
  @HttpCode(202) // Accepted: o trabalho foi ACEITO, não concluído.
  async syncBroadcasts(): Promise<ZernioBroadcastSyncEnqueued> {
    await this.queue.add(
      'sync-broadcasts-manual',
      {},
      { jobId: 'zernio-broadcast-sync-manual' },
    );
    return { enqueued: true };
  }

  /**
   * ★ QUEM FICOU NA DÚVIDA — o recorte que torna a instrução EXECUTÁVEL.
   *
   * Quando o `POST /send` do Zernio não responde, o lote fica `SENT` sem que
   * ninguém saiba se foi entregue (ver `settleIndeterminateSend`: marcar FAILED
   * seria pior, porque FAILED é terminal para o webhook e faria o lote seguinte
   * reenviar para essas pessoas). O código instruía o operador a "conferir o
   * painel do Zernio antes de redisparar" — só que SENT conta como RECEBIDO em
   * TODO recorte do produto: o "Disparar novamente" (modo `unreached`) e o tick
   * recorrente pulam exatamente essas pessoas, e o único modo que as alcança
   * (`full`) reenviaria para a audiência inteira. A instrução existia, mas não
   * havia como executá-la.
   *
   * Este endpoint fecha esse buraco: ele NOMEIA as pessoas afetadas — o mínimo
   * para que "risco documentado" não seja "buraco silencioso".
   *
   * O filtro é o MARCADOR (`INDETERMINATE_DELIVERY_MARK`), não "SENT sem wamid":
   * toda mensagem recém-disparada por broadcast é SENT sem wamid até o webhook
   * chegar, então esse critério devolveria a campanha inteira.
   */
  @Roles('ADMIN')
  @ApiOperation({
    summary:
      'Lista os contatos cuja entrega ficou INDETERMINADA (o POST /send do Zernio não respondeu)',
  })
  @Get('indeterminate-deliveries')
  async indeterminateDeliveries(
    @Query('campaignId') campaignId?: string,
  ): Promise<ZernioIndeterminateDeliveries> {
    const rows = await this.prisma.message.findMany({
      where: {
        ...(campaignId ? { campaignId } : {}),
        status: 'SENT',
        zernioBroadcastId: { not: null },
        errorMessage: { startsWith: INDETERMINATE_DELIVERY_MARK },
      },
      select: {
        id: true,
        sentAt: true,
        contact: { select: { id: true, name: true, phoneE164: true } },
        zernioBroadcast: { select: { zernioId: true, name: true } },
      },
      orderBy: { sentAt: 'desc' },
      // Um teto sadio: isto é um diagnóstico de incidente, não um export.
      take: 5000,
    });

    return {
      total: rows.length,
      comoAgir: COMO_AGIR,
      contacts: rows.map((r) => ({
        messageId: r.id,
        contactId: r.contact?.id ?? null,
        name: r.contact?.name ?? null,
        phoneE164: r.contact?.phoneE164 ?? null,
        sentAt: r.sentAt,
        zernioBroadcastId: r.zernioBroadcast?.zernioId ?? null,
        zernioBroadcastName: r.zernioBroadcast?.name ?? null,
      })),
    };
  }
}
