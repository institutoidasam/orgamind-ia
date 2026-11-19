import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { ChannelProvider, Prisma } from '@prisma/client';
import { AuditService } from '../../shared/audit/audit.service';
import {
  ENABLED_CHANNEL_PROVIDERS,
  isEnabledChannelProvider,
} from '../../shared/config/enabled-providers';
import { DomainError } from '../../shared/errors/domain.error';
import {
  ChannelProviderDisabledError,
  PROVIDER_DISABLED_CODE,
} from '../../shared/errors/channel-provider-disabled.error';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { CampaignsService } from '../campaigns/campaigns.service';
import { classifyFailure } from '../campaigns/failure-reason';
import { InstanceNotFoundError } from '../whatsapp-instances/errors/instance.errors';

export type DisabledChannel = {
  id: string;
  name: string;
  provider: ChannelProvider;
  phoneE164: string | null;
  sectorNames: string[];
};

export type RemoveDisabledChannelResult = {
  channelId: string;
  detachedSectorIds: string[];
  failedMessages: number;
};

const notDisabled = () =>
  new DomainError({
    code: 'channel.not_disabled',
    message: 'Esta conexão é Evolution: remova pelo menu da conexão.',
    status: 422,
  });

/** Estados de mensagem que ficariam parados para sempre num canal removido (D11). */
const STRANDED_STATUSES = ['WAITING_INSTANCE', 'QUEUED'] as const;

/**
 * Números (Channel) de provedores desligados (R3/R6). Só o ADMIN os vê e os
 * remove (a rota decide); aqui ficam a leitura e a remoção local, SEM chamada
 * a API externa: o que existe no provedor desligado não é apagado por aqui.
 */
@Injectable()
export class DisabledChannelsService {
  private readonly logger = new Logger(DisabledChannelsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly moduleRef: ModuleRef,
  ) {}

  /** Números ativos de provedor desligado, por nome, com as áreas ativas deles. */
  async listDisabled(): Promise<DisabledChannel[]> {
    const channels = await this.prisma.channel.findMany({
      where: {
        isActive: true,
        provider: { notIn: [...ENABLED_CHANNEL_PROVIDERS] },
      },
      select: { id: true, name: true, provider: true, phoneE164: true },
      orderBy: { name: 'asc' },
    });
    if (channels.length === 0) return [];
    const sectors = await this.prisma.sector.findMany({
      where: { channelId: { in: channels.map((c) => c.id) }, isActive: true },
      select: { name: true, channelId: true },
      orderBy: { name: 'asc' },
    });
    return channels.map((c) => ({
      ...c,
      sectorNames: sectors
        .filter((s) => s.channelId === c.id)
        .map((s) => s.name),
    }));
  }

  /**
   * Remove um número ativo de provedor desligado, numa transação só: inativa
   * (e tira o padrão), solta as áreas e falha as mensagens paradas dele
   * (WAITING_INSTANCE/QUEUED), que sem isso ficariam assim para sempre (D11) —
   * o mesmo padrão de `WhatsappInstancesService.delete`. Inexistente ou já
   * inativo dá 404; Evolution dá 422 `channel.not_disabled`.
   */
  async remove(input: {
    channelId: string;
    actorId: string;
  }): Promise<RemoveDisabledChannelResult> {
    const { channelId, actorId } = input;
    const { provider, campaignIds, ...result } = await this.prisma.$transaction(
      (tx) => this.removeInTransaction(tx, channelId),
    );
    await this.audit.log('channel.disabled_remove', 'Channel', channelId, {
      channelId,
      provider,
      detachedSectorIds: result.detachedSectorIds,
      failedMessages: result.failedMessages,
      actorId,
    });
    await this.completeCampaigns(campaignIds);
    return { channelId, ...result };
  }

  private async removeInTransaction(
    tx: Prisma.TransactionClient,
    channelId: string,
  ) {
    // Trava a linha: duas remoções simultâneas não falham as mensagens duas vezes.
    await tx.$queryRaw`SELECT id FROM "WhatsappInstance" WHERE id = ${channelId} FOR UPDATE`;
    const channel = await tx.channel.findUnique({
      where: { id: channelId },
      select: { id: true, provider: true, isActive: true },
    });
    if (!channel?.isActive) throw new InstanceNotFoundError(channelId);
    if (isEnabledChannelProvider(channel.provider)) throw notDisabled();

    const sectors = await tx.sector.findMany({
      where: { channelId },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    await tx.channel.update({
      where: { id: channelId },
      data: { isActive: false, isDefault: false },
    });
    await tx.sector.updateMany({
      where: { channelId },
      data: { channelId: null },
    });
    return {
      provider: channel.provider,
      detachedSectorIds: sectors.map((s) => s.id),
      ...(await this.failStranded(tx, channelId, channel.provider)),
    };
  }

  /**
   * Falha as mensagens paradas do número (D11) e devolve as campanhas delas,
   * lidas antes do `updateMany` para a conta bater com o que foi falhado.
   */
  private async failStranded(
    tx: Prisma.TransactionClient,
    channelId: string,
    provider: ChannelProvider,
  ) {
    const stranded = {
      instanceId: channelId,
      status: { in: [...STRANDED_STATUSES] },
    };
    const campaigns = await tx.message.groupBy({
      by: ['campaignId'],
      where: { ...stranded, campaignId: { not: null } },
    });
    const failed = await tx.message.updateMany({
      where: stranded,
      data: {
        status: 'FAILED',
        errorCode: PROVIDER_DISABLED_CODE,
        errorMessage: new ChannelProviderDisabledError(provider).message,
        // Mesmos campos que o SendMessageProcessor grava para este código: o
        // painel de motivos agrega por `failureReason`.
        failedAt: new Date(),
        failureReason: classifyFailure(PROVIDER_DISABLED_CODE, provider),
      },
    });
    return {
      failedMessages: failed.count,
      campaignIds: campaigns.flatMap((g) =>
        g.campaignId ? [g.campaignId] : [],
      ),
    };
  }

  /**
   * Uma campanha cuja última parada acabou de virar FAILED não pode ficar
   * RUNNING (N2). Best-effort, como no SendMessageProcessor: falha só vira log.
   *
   * O `CampaignsService` é resolvido sob demanda (`ModuleRef`), não injetado:
   * `WhatsappProvidersModule → CampaignsModule` fecharia o ciclo
   * `CampaignsModule → TemplatesModule → WhatsappProvidersModule`.
   */
  private async completeCampaigns(campaignIds: readonly string[]) {
    if (campaignIds.length === 0) return;
    try {
      const campaigns = this.moduleRef.get(CampaignsService, { strict: false });
      for (const id of campaignIds) {
        await campaigns.maybeCompleteCampaign(id).catch((err: unknown) => {
          this.logger.warn(
            `maybeCompleteCampaign falhou para a campanha ${id}: ${(err as Error).message}`,
          );
        });
      }
    } catch (err) {
      this.logger.warn(
        `CampaignsService indisponível; campanhas não reavaliadas: ${(err as Error).message}`,
      );
    }
  }
}
