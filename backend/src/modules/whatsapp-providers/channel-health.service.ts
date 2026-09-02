import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../shared/prisma/prisma.service';
import {
  ZernioAccountsService,
  parseZernioTier,
  type ZernioAccount,
  type ZernioNumberHealth,
} from './zernio-accounts.service';
import type { ChannelHealth } from '../../schemas/contracts/instance.schema';

/**
 * A partir de quanto do teto o operador precisa ser AVISADO. O teto da Meta é
 * de usuários ÚNICOS em 24h ROLANTES: estourá-lo faz a Meta rejeitar em massa,
 * o quality rating despencar e o tier CAIR. O aviso tem de chegar com folga
 * para dar tempo de parar a campanha — 80% dá ~400 destinatários de margem no
 * TIER_2K do cliente.
 */
export const NEAR_TIER_LIMIT_PCT = 80;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * ZB — a saúde dos canais cloud, como a página Canais precisa ver ANTES de
 * qualquer disparo.
 *
 * Hoje o operador dispara ÀS CEGAS: não vê o tier, não vê quanto do tier já
 * gastou, não vê o quality rating e — o caso real do cliente — não vê que o
 * `nameStatus` está **DECLINED**, o que faz o destinatário ver o NÚMERO em vez
 * do nome do negócio no cabeçalho do chat, derrubando a confiança e, com ela, a
 * taxa de bloqueio/denúncia que é exatamente o que despenca o quality rating.
 *
 * Leitura ao vivo, SOB DEMANDA (o operador abre a tela) — nunca em polling: o
 * balde do Zernio é de 60 req/min POR CHAVE e é o MESMO do envio.
 *
 * Degradação em cascata, porque a tela nunca pode ficar vazia:
 *   1. `GET /whatsapp/number-info` (o mais rico: + `can_send_message` e motivo)
 *   2. `GET /accounts` → `metadata` (tier/qualidade/nameStatus, sem o veredito)
 *   3. o que o `zernio-tier-sync` já persistiu no próprio `Channel`
 * Os níveis 2 e 3 marcam `stale: true` — dado velho ROTULADO como velho é
 * honesto; dado velho disfarçado de fresco é o que faz o operador disparar
 * confiante em cima de um número queimado.
 */
@Injectable()
export class ChannelHealthService {
  private readonly logger = new Logger(ChannelHealthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly accounts: ZernioAccountsService,
  ) {}

  async list(): Promise<{ channels: ChannelHealth[] }> {
    // Deploy sem credencial Zernio → não há saúde a mostrar (e nem uma chamada
    // a fazer).
    if (!this.accounts.configured) return { channels: [] };

    const channels = await this.prisma.channel.findMany({
      where: {
        provider: 'ZERNIO',
        isActive: true,
        zernioAccountId: { not: null },
      },
      orderBy: { createdAt: 'asc' },
    });
    if (channels.length === 0) return { channels: [] };

    // Fallback nível 2, buscado UMA vez para todos os canais (o `/accounts`
    // devolve todas as contas de uma tacada; o `number-info` custa 1 req POR
    // conta). Falhou → mapa vazio e cada canal cai no nível 3.
    const byAccountId = await this.listAccountsQuietly();

    const out: ChannelHealth[] = [];
    for (const channel of channels) {
      // A query acima já exclui os sem conta, mas um canal a meio da
      // configuração não tem NADA a consultar e cada `number-info` custa balde
      // de rate limit — o skip fica explícito aqui em vez de depender só do WHERE.
      const accountId = channel.zernioAccountId;
      if (!accountId) continue;
      const [info, uniqueRecipients24h] = await Promise.all([
        this.accounts.fetchNumberInfo(accountId),
        this.countUniqueRecipients24h(channel.id),
      ]);
      out.push(
        this.compose(
          channel,
          accountId,
          info,
          byAccountId.get(accountId),
          uniqueRecipients24h,
        ),
      );
    }
    return { channels: out };
  }

  /**
   * A MESMA contagem que a guarda rolante de 24h faz antes de cada envio
   * (send-message.processor.ts): destinatários ÚNICOS, não mensagens. O card
   * precisa mostrar o número pelo qual o operador vai ser BLOQUEADO — mostrar
   * outro (ex.: `sentToday`, que é dia-calendário) seria pior do que não mostrar
   * nada.
   */
  private async countUniqueRecipients24h(channelId: string): Promise<number> {
    const since = new Date(Date.now() - DAY_MS);
    const rows = await this.prisma.message.groupBy({
      by: ['contactId'],
      where: {
        instanceId: channelId,
        direction: 'OUTBOUND',
        contactId: { not: null },
        sentAt: { gte: since },
      },
    });
    return rows.length;
  }

  /** `GET /accounts` indexado por id — nunca lança (fallback é best-effort). */
  private async listAccountsQuietly(): Promise<Map<string, ZernioAccount>> {
    try {
      const accounts = await this.accounts.listAccounts();
      return new Map(accounts.map((a) => [a.id, a]));
    } catch (err) {
      this.logger.warn(
        `GET /accounts indisponível (${
          err instanceof Error ? err.message : String(err)
        }) — a saúde cai no que está persistido no canal`,
      );
      return new Map();
    }
  }

  private compose(
    channel: {
      id: string;
      name: string;
      phoneE164: string | null;
      dailySendLimit: number;
      qualityRating: string | null;
    },
    accountId: string,
    info: ZernioNumberHealth | null,
    account: ZernioAccount | undefined,
    uniqueRecipients24h: number,
  ): ChannelHealth {
    const messagingLimitTier =
      info?.messagingLimitTier ?? account?.messagingLimitTier;
    const qualityRating =
      info?.qualityRating ?? account?.qualityRating ?? channel.qualityRating ?? undefined;
    const nameStatus = info?.nameStatus ?? account?.nameStatus;

    // Tier desconhecido → NUNCA inventa um teto: usa o do canal (que o
    // tier-sync mantém). A Meta já anunciou a aposentadoria de TIER_2K/10K no
    // Q2/2026, então "tier que não conheço" é um cenário esperado, não um bug.
    const tierLimit =
      parseZernioTier(messagingLimitTier) ?? channel.dailySendLimit;
    const tierUsagePct =
      tierLimit > 0
        ? Math.floor((uniqueRecipients24h / tierLimit) * 100)
        : 0;

    return {
      channelId: channel.id,
      channelName: channel.name,
      provider: 'ZERNIO',
      zernioAccountId: accountId,
      displayPhoneNumber:
        info?.displayPhoneNumber ?? account?.phoneE164 ?? channel.phoneE164 ?? undefined,
      messagingLimitTier,
      tierLimit,
      uniqueRecipients24h,
      tierUsagePct,
      nearTierLimit: tierUsagePct >= NEAR_TIER_LIMIT_PCT,
      qualityRating,
      nameStatus,
      nameRejectionReason: info?.nameRejectionReason,
      canSendMessage: info?.canSendMessage,
      canSendMessageReason: info?.canSendMessageReason,
      // `stale` = a leitura rica falhou; o que está na tela veio do `/accounts`
      // ou do banco. O card diz isso em voz alta.
      stale: info === null,
      syncedAt: new Date(),
    };
  }
}
