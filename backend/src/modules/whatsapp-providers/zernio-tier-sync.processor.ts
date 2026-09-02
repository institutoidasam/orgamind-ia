import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { AuditService } from '../../shared/audit/audit.service';
import { CampaignsService } from '../campaigns/campaigns.service';
import {
  ZernioAccountsService,
  parseZernioTier,
} from './zernio-accounts.service';
import { QUEUE_NAMES } from '../queue/queue.constants';

/**
 * ZA3 — qualidade DEGRADADA na Meta. `UNKNOWN` não entra: é "sem dados"
 * (número novo/sem volume), não "ruim".
 */
const DEGRADED_QUALITY = new Set(['YELLOW', 'RED', 'FLAGGED']);

const isDegraded = (rating: string | null | undefined): boolean =>
  !!rating && DEGRADED_QUALITY.has(rating.toUpperCase());

/**
 * Tier sync diário do ZERNIO (ZA2) — espelho do `twilio-tier-sync`.
 *
 * O tier da Meta (50 → 250 → 1K → 2K → 10K → 100K → ilimitado, **usuários
 * ÚNICOS em 24h ROLANTES**) sobe e DESCE sem webhook nenhum. A leitura canônica
 * é `GET /accounts` do Zernio → `metadata.messagingLimitTier`. Este job
 * repetível (24h, registrado no worker.ts) casa cada conta com os canais ZERNIO
 * ativos **pelo `zernioAccountId`** (nunca pelo telefone: o número vem
 * formatado pela Meta e o canal pode nem tê-lo) e, quando o teto difere do
 * `dailySendLimit`, atualiza + audita (`channel.tier_sync`).
 *
 * Duas regras de segurança:
 * - tier desconhecido/ausente → **não mexe** (ver parseZernioTier);
 * - o `qualityRating` é PERSISTIDO a cada rodada, porque o kill-switch de
 *   qualidade reage à TRANSIÇÃO (sair de GREEN), não ao valor — sem o estado
 *   anterior não há transição a detectar.
 *
 * Custo no balde: 1 requisição por rodada (`GET /accounts` devolve todas as
 * contas). O balde do Zernio é de 60 req/min POR CHAVE de API e é o MESMO do
 * envio — daí o tick ser de 24h e não de minutos.
 */
@Processor(QUEUE_NAMES.ZERNIO_TIER_SYNC, { concurrency: 1 })
export class ZernioTierSyncProcessor extends WorkerHost {
  private readonly logger = new Logger(ZernioTierSyncProcessor.name);

  constructor(
    private readonly accounts: ZernioAccountsService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly campaigns: CampaignsService,
  ) {
    super();
  }

  /**
   * ZA3 — kill-switch de QUALIDADE.
   *
   * O `qualityRating` da Meta é calculado sobre BLOQUEIOS e DENÚNCIAS dos
   * destinatários nos últimos 7 dias. Sair de GREEN é o aviso que precede a
   * queda de tier e a restrição da conta. Continuar disparando em cima de um
   * número em YELLOW/RED é a forma mais rápida de perdê-lo — então as campanhas
   * ATIVAS daquele canal são interrompidas pelo mesmo mecanismo do kill-switch
   * de template (`CampaignsService.cancel`: drena os jobs da fila + CANCELLED
   * nas mensagens ainda QUEUED).
   *
   * Dispara na TRANSIÇÃO para um estado degradado (o estado anterior vem da
   * coluna `Channel.qualityRating`), nunca no estado em si: um canal que já
   * estava RED não re-cancela campanhas a cada rodada. Um número que nunca teve
   * leitura (NULL/UNKNOWN) e aparece direto em RED também dispara — o risco é o
   * mesmo, e sem isso o pior caso ficaria descoberto.
   *
   * Best-effort por campanha: um cancelamento que falha não impede os demais
   * nem aborta o tick.
   */
  private async reactToQualityDrop(
    channel: { id: string; qualityRating: string | null },
    quality: string,
  ): Promise<void> {
    const active = await this.prisma.campaign.findMany({
      where: {
        defaultInstanceId: channel.id,
        status: { in: ['RUNNING', 'QUEUED'] },
      },
      select: { id: true },
    });

    const paused: string[] = [];
    for (const campaign of active) {
      try {
        await this.campaigns.cancel(campaign.id);
        paused.push(campaign.id);
      } catch (err) {
        this.logger.error(
          `zernio-tier-sync: falha ao pausar a campanha ${campaign.id} após queda de qualidade: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    // Alerta visível: log de ERRO + Sentry + audit (a trilha que a interface
    // mostra). O operador PRECISA saber que o número está queimando.
    const alerta = `[quality-drop] canal ZERNIO ${channel.id}: qualityRating ${
      channel.qualityRating ?? '(sem leitura)'
    } → ${quality}. ${paused.length} campanha(s) ativa(s) pausada(s). O número está acumulando bloqueios/denúncias — NÃO retomar o disparo antes de investigar.`;
    this.logger.error(alerta);
    Sentry.captureMessage(alerta, 'error');
    await this.audit.log('channel.quality_drop', 'Channel', channel.id, {
      previousQualityRating: channel.qualityRating,
      qualityRating: quality,
      pausedCampaigns: paused,
    });
  }

  async process(): Promise<void> {
    // Deploy sem credencial Zernio → nada a sincronizar (e sem 401 diário).
    if (!this.accounts.configured) return;

    const channels = await this.prisma.channel.findMany({
      where: { provider: 'ZERNIO', isActive: true },
    });
    if (channels.length === 0) return;

    // Uma falha aqui lança e falha o tick (BullMQ registra) — melhor do que
    // rodar o loop com um catálogo parcial e "não casar" canais que existem.
    const accounts = await this.accounts.listAccounts();
    const byId = new Map(accounts.map((a) => [a.id, a]));

    let updated = 0;
    let unchanged = 0;
    let unmatched = 0;
    for (const channel of channels) {
      try {
        const account = channel.zernioAccountId
          ? byId.get(channel.zernioAccountId)
          : undefined;
        if (!account) {
          unmatched++;
          continue;
        }

        const limit = parseZernioTier(account.messagingLimitTier);
        const quality = account.qualityRating ?? null;

        // ZA3 — a qualidade DEGRADOU nesta rodada? A reação vem ANTES do
        // update do canal: se o processo morrer no meio, o `qualityRating`
        // antigo continua gravado e a próxima rodada tenta de novo (perder a
        // pausa seria pior do que pausar duas vezes — cancel é idempotente).
        if (
          quality !== null &&
          quality !== channel.qualityRating &&
          isDegraded(quality) &&
          !isDegraded(channel.qualityRating)
        ) {
          await this.reactToQualityDrop(channel, quality);
        }

        const data: {
          dailySendLimit?: number;
          qualityRating?: string;
          zernioProfileId?: string;
        } = {};
        // null = tier desconhecido → NÃO inventa teto (mantém o do canal).
        if (limit !== null && limit !== channel.dailySendLimit) {
          data.dailySendLimit = limit;
        }
        if (quality !== null && quality !== channel.qualityRating) {
          data.qualityRating = quality;
        }
        // ZC — o `profileId` é OBRIGATÓRIO no `POST /broadcasts`, e canais criados
        // antes deste campo estão com NULL. Este job já lê `GET /accounts` (onde o
        // profileId vive) toda rodada: fazer o backfill aqui é de graça, e sem ele
        // a campanha nativa do Zernio falharia num canal antigo.
        if (account.profileId && account.profileId !== channel.zernioProfileId) {
          data.zernioProfileId = account.profileId;
        }
        if (Object.keys(data).length === 0) {
          unchanged++;
          continue;
        }

        await this.prisma.channel.update({ where: { id: channel.id }, data });
        // Actor null — mudança automática vinda da Meta (via Zernio).
        await this.audit.log('channel.tier_sync', 'Channel', channel.id, {
          previousLimit: channel.dailySendLimit,
          newLimit: data.dailySendLimit ?? channel.dailySendLimit,
          messagingLimitTier: account.messagingLimitTier,
          previousQualityRating: channel.qualityRating,
          qualityRating: quality,
          zernioAccountId: account.id,
        });
        updated++;
        this.logger.log(
          `zernio-tier-sync: canal ${channel.id} (${account.id}) ${JSON.stringify(data)} (messagingLimitTier="${account.messagingLimitTier ?? '(ausente)'}", qualityRating="${quality ?? '(ausente)'}")`,
        );
      } catch (err) {
        this.logger.warn(
          `zernio-tier-sync: erro sincronizando canal ${channel.id}: ${
            err instanceof Error ? err.message : String(err)
          } — pulando`,
        );
      }
    }

    this.logger.log(
      `zernio-tier-sync: channels=${channels.length} updated=${updated} unchanged=${unchanged} unmatched=${unmatched}`,
    );
  }
}
