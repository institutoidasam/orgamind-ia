import { Injectable, Logger } from '@nestjs/common';
import type { ChannelProvider } from '@prisma/client';
import { PrismaService } from '../../shared/prisma/prisma.service';

/** Janela do alerta: um problema que parou de acontecer há 7 dias não é notícia. */
const DEFAULT_WINDOW_DAYS = 7;

/** Um alerta pronto para a UI: uma conta órfã, com tudo o que já se perdeu dela. */
export type WebhookDropAlert = {
  provider: ChannelProvider;
  /** ZERNIO → accountId; TWILIO → o número `To`. */
  accountRef: string;
  /** Soma dos eventos perdidos dessa conta. */
  totalCount: number;
  /** Os tipos de evento perdidos, ordenados. */
  events: string[];
  firstSeenAt: Date;
  lastSeenAt: Date;
};

/**
 * Torna VISÍVEL a perda silenciosa de webhook.
 *
 * O incidente: webhooks do Zernio chegavam para uma conta sem canal configurado,
 * autenticavam (HMAC ok), respondiam 200 e eram descartados com um `logger.warn`.
 * Um disparo real de ~100 mensagens (24 read, 5 received, 4 delivered) evaporou
 * assim — conversas e dashboard vazios, e nenhuma pista na interface.
 *
 * Um `warn` no log não é detecção: ninguém lê log de produção por hábito. Aqui
 * cada descarte vira uma LINHA CONTADA que a página Canais exibe como alerta.
 */
@Injectable()
export class WebhookDropsService {
  private readonly logger = new Logger(WebhookDropsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Registra (ou incrementa) o descarte de um webhook sem canal correspondente.
   *
   * Best-effort por contrato: engole o próprio erro, como o AuditService. Isto é
   * DIAGNÓSTICO — se a escrita falhar, não pode virar um 500 que faz o provedor
   * retentar o mesmo evento 7x.
   */
  async record(args: {
    provider: ChannelProvider;
    accountRef: string;
    event: string;
  }): Promise<void> {
    const { provider, accountRef, event } = args;
    try {
      await this.prisma.webhookDrop.upsert({
        where: {
          provider_accountRef_event: { provider, accountRef, event },
        },
        update: { count: { increment: 1 }, lastSeenAt: new Date() },
        create: { provider, accountRef, event },
      });
    } catch (err) {
      this.logger.error(
        `falha ao registrar WebhookDrop provider=${provider} account=${accountRef} event=${event}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Os alertas ATIVOS: contas que perderam eventos na janela recente e que
   * CONTINUAM sem canal ativo correspondente.
   *
   * A resolução é automática: assim que o operador cria o canal certo, a conta
   * passa a resolver e o alerta some sozinho — ninguém precisa "dar baixa" no
   * aviso, o que sempre acaba não acontecendo.
   */
  async listUnresolved(windowDays = DEFAULT_WINDOW_DAYS): Promise<WebhookDropAlert[]> {
    const since = new Date(Date.now() - windowDays * 24 * 3600 * 1000);
    const [drops, channels] = await Promise.all([
      this.prisma.webhookDrop.findMany({
        where: { lastSeenAt: { gte: since } },
        orderBy: { lastSeenAt: 'desc' },
      }),
      this.prisma.channel.findMany({
        where: { isActive: true },
        select: { provider: true, zernioAccountId: true, phoneE164: true },
      }),
    ]);

    // As identidades que HOJE resolvem um canal ativo — chaveadas do mesmo jeito
    // que o accountRef do drop (ZERNIO → accountId, TWILIO/demais → phoneE164).
    const resolved = new Set<string>();
    for (const ch of channels) {
      if (ch.zernioAccountId) resolved.add(`${ch.provider}:${ch.zernioAccountId}`);
      if (ch.phoneE164) resolved.add(`${ch.provider}:${ch.phoneE164}`);
    }

    const byAccount = new Map<string, WebhookDropAlert>();
    for (const d of drops) {
      const key = `${d.provider}:${d.accountRef}`;
      if (resolved.has(key)) continue; // já tem canal → problema resolvido
      const existing = byAccount.get(key);
      if (!existing) {
        byAccount.set(key, {
          provider: d.provider,
          accountRef: d.accountRef,
          totalCount: d.count,
          events: [d.event],
          firstSeenAt: d.firstSeenAt,
          lastSeenAt: d.lastSeenAt,
        });
        continue;
      }
      existing.totalCount += d.count;
      if (!existing.events.includes(d.event)) existing.events.push(d.event);
      if (d.firstSeenAt < existing.firstSeenAt) existing.firstSeenAt = d.firstSeenAt;
      if (d.lastSeenAt > existing.lastSeenAt) existing.lastSeenAt = d.lastSeenAt;
    }

    for (const alert of byAccount.values()) alert.events.sort();
    return [...byAccount.values()].sort(
      (a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime(),
    );
  }
}
