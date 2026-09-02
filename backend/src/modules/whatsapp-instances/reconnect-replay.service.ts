import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { isSessionProvider } from '../../schemas/contracts/channel-provider.schema';

@Injectable()
export class ReconnectReplayService {
  private readonly logger = new Logger(ReconnectReplayService.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue('send-message') private readonly queue: Queue,
  ) {}

  /**
   * ★ A VARREDURA PELO LADO DAS MENSAGENS — incidente 2026-08-14.
   *
   * O replay sempre foi disparado pelo lado do CANAL: o laço de cada provedor
   * percorre os canais DELE e, para cada um aberto, pergunta "tem mensagem
   * parada aqui?". Isso tem um furo estrutural — os laços têm FILTROS (o do
   * GoZap só olha canal ATIVO e COM token) e uma mensagem parada num canal que
   * o laço pula fica invisível PARA SEMPRE. Foi assim que 488 mensagens
   * passaram dois dias paradas com o número reconectado e nada acontecendo: o
   * canal delas simplesmente não era visitado por ninguém.
   *
   * Aqui a pergunta é INVERTIDA: parte das mensagens paradas, não dos canais.
   * Nenhum filtro de provedor pode esconder uma mensagem de si mesma.
   *
   * O log de cada grupo é intencional e sai SEMPRE que há mensagem parada — é
   * a única janela para um estado que, por definição, ninguém está olhando.
   */
  async sweepParked(): Promise<void> {
    const grupos = await this.prisma.message.groupBy({
      by: ['instanceId'],
      where: { status: 'WAITING_INSTANCE' },
      _count: { _all: true },
    });
    if (grupos.length === 0) return;

    for (const g of grupos) {
      const paradas = g._count._all;
      if (!g.instanceId) {
        this.logger.warn(
          `paradas: ${paradas} mensagem(ns) WAITING_INSTANCE SEM canal — ` +
            `não há para onde soltá-las.`,
        );
        continue;
      }
      const canal = await this.prisma.channel.findUnique({
        where: { id: g.instanceId },
        select: { id: true, name: true, provider: true, isActive: true },
      });
      if (!canal) {
        this.logger.warn(
          `paradas: ${paradas} para instance=${g.instanceId}, que NÃO EXISTE mais.`,
        );
        continue;
      }

      // Mesma regra do roteador de envio: provedor de sessão (Evolution/GoZap)
      // precisa de um evento 'open' gravado; os oficiais (Twilio/Zernio/Meta)
      // não geram evento nenhum e estão sempre alcançáveis. Divergir daqui
      // faria a varredura soltar mensagem que o roteador vai reestacionar.
      const online = !isSessionProvider(canal.provider)
        ? true
        : (
            await this.prisma.whatsappConnectionEvent.findFirst({
              where: { instanceId: canal.id },
              orderBy: { occurredAt: 'desc' },
            })
          )?.state === 'open';

      this.logger.log(
        `paradas: ${paradas} em instance=${canal.id} ("${canal.name}", ` +
          `${canal.provider}) ativo=${canal.isActive} online=${online}`,
      );

      // Canal inativo NÃO é despertado aqui: quem cuida dele é a adoção, que
      // migra as paradas para um canal vivo com o MESMO número. Soltá-las por
      // um canal removido seria enviar por uma sessão que ninguém mantém.
      if (canal.isActive && online) {
        await this.replayWaitingFor(canal.id);
      }
    }
  }

  /**
   * ★ ADOÇÃO DE ÓRFÃS — INCIDENTE 2026-08-12/14, 488 mensagens perdidas.
   *
   * A campanha foi criada apontando para um canal; o canal foi APAGADO (soft
   * delete) e o mesmo número reconectado num REGISTRO NOVO, com id novo. As
   * mensagens seguiram apontando para o canal morto, e o replay — que busca
   * por `instanceId` — perguntava ao canal vivo "tem parada para ESTE id?",
   * ouvia não, e as 488 ficavam presas para sempre. Reconectar o número não
   * resolvia: o vínculo quebrado era com o REGISTRO do canal, não com o
   * WhatsApp.
   *
   * A regra é deliberadamente CONSERVADORA: só adota de canal INATIVO com o
   * MESMO provedor e o MESMO número. Mesmo número = mesmo remetente, e o
   * destinatário não percebe diferença nenhuma. Sem essa igualdade a migração
   * mandaria a mensagem por OUTRO número — pior do que deixá-la parada, porque
   * seria uma troca de remetente que ninguém autorizou.
   *
   * Canal sem `phoneE164` nunca adota: sem número não há como provar identidade
   * de remetente, e adivinhar aqui é exatamente o que não se pode fazer.
   */
  private async adoptOrphanedWaiting(instanceId: string): Promise<void> {
    const alvo = await this.prisma.channel.findUnique({
      where: { id: instanceId },
      select: { id: true, provider: true, phoneE164: true, isActive: true },
    });
    if (!alvo?.isActive || !alvo.phoneE164) return;

    const mortos = await this.prisma.channel.findMany({
      where: {
        isActive: false,
        provider: alvo.provider,
        phoneE164: alvo.phoneE164,
        id: { not: alvo.id },
      },
      select: { id: true },
    });
    if (mortos.length === 0) return;

    const { count } = await this.prisma.message.updateMany({
      where: {
        instanceId: { in: mortos.map((c) => c.id) },
        status: 'WAITING_INSTANCE',
      },
      data: { instanceId: alvo.id },
    });
    if (count > 0) {
      this.logger.warn(
        `Adotadas ${count} mensagens WAITING_INSTANCE de ${mortos.length} canal(is) ` +
          `removido(s) com o mesmo número (${alvo.phoneE164}) para instance=${alvo.id}. ` +
          `Elas estavam órfãs desde que aquele canal foi apagado.`,
      );
    }
  }

  async replayWaitingFor(instanceId: string): Promise<void> {
    // Antes de procurar as paradas DESTE canal, recolhe as que ficaram órfãs
    // num canal removido com o mesmo número — senão elas nunca seriam achadas.
    await this.adoptOrphanedWaiting(instanceId);

    // Read the EXACT WAITING_INSTANCE rows first, capturing their ids +
    // campaign/contact references. We must enqueue precisely this cohort:
    // re-selecting the rows to replay by status='QUEUED' would also match
    // pre-existing campaign messages (created QUEUED with the same instanceId
    // and a live BullMQ job — see CampaignsService dispatch), so a take:count
    // budget could pick the wrong rows and strand the just-reconnected ones in
    // QUEUED with no job — never sent.
    const messages = await this.prisma.message.findMany({
      where: { instanceId, status: 'WAITING_INSTANCE' },
      orderBy: { queuedAt: 'asc' },
      select: { id: true, campaignId: true, contactId: true },
    });

    if (messages.length === 0) return;

    // Atomically claim exactly those rows WAITING_INSTANCE → QUEUED. The
    // status guard means a retried CONNECTION_UPDATE webhook (or a concurrent
    // replay that read the same ids) flips 0 rows here and exits early —
    // preventing duplicate BullMQ jobs and duplicate WhatsApp sends.
    const { count } = await this.prisma.message.updateMany({
      where: { id: { in: messages.map((m) => m.id) }, status: 'WAITING_INSTANCE' },
      data: { status: 'QUEUED' },
    });

    if (count === 0) return;

    this.logger.log(
      `Replaying ${messages.length} WAITING_INSTANCE messages for instance=${instanceId}`,
    );

    for (const m of messages) {
      try {
        await this.queue.add('send-message', {
          messageId: m.id,
          campaignId: m.campaignId,
          contactId: m.contactId,
        });
      } catch (err) {
        // Mirror CampaignsService.enqueueOrFail: if the enqueue itself fails
        // (Redis outage, etc.) mark this row FAILED so it doesn't sit in QUEUED
        // forever with no job to pick it up. We keep looping (rather than
        // rethrow) so a mid-loop failure can't strand the remaining rows.
        // Scoped to status='QUEUED': if the row is no longer QUEUED, some other
        // actor already moved it on (the job DID make it into the queue and a
        // worker claimed it into e.g. SENDING) — this write must not clobber
        // that with a stale FAILED.
        const errorMessage = err instanceof Error ? err.message : String(err);
        await this.prisma.message.updateMany({
          where: { id: m.id, status: 'QUEUED' },
          data: {
            status: 'FAILED',
            errorCode: 'enqueue_failed',
            errorMessage,
            failedAt: new Date(),
          },
        });
        this.logger.error(
          `Failed to enqueue replay for message=${m.id} instance=${instanceId}: ${errorMessage}`,
        );
      }
    }
  }
}
