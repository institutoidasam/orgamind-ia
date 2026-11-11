import { Injectable, type Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { AuditService } from '../../shared/audit/audit.service';
import { DomainError } from '../../shared/errors/domain.error';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { InstanceNotFoundError } from '../whatsapp-instances/errors/instance.errors';
import {
  SECTOR_CHANNEL_SELECT,
  effectiveChannel,
} from '../team-whatsapp/sector-channel';

export type ChannelSector = { id: string; name: string };
export type MovedSector = { sectorId: string; fromChannelId: string };
export type ChannelSectorsResult = {
  channelId: string;
  sectors: ChannelSector[];
  moved: MovedSector[];
};

const sectorInvalid = () =>
  new DomainError({
    code: 'channel.sector_invalid',
    message: 'Alguma área escolhida não existe ou está inativa.',
    status: 422,
  });

const sectorsNotTeam = () =>
  new DomainError({
    code: 'channel.sectors_not_team',
    message:
      'Só um número ativo do GoZap ou da Evolution pode atender áreas da equipe.',
    status: 422,
  });

/**
 * Associa as áreas a um número que ACABOU de ser criado no provedor. O número já
 * existe (e na Evolution repetir a criação abriria outra sessão), então uma
 * falha aqui não derruba a resposta: registra só o id do número e o código do
 * erro (GC8, sem telefone nem nomes) e devolve lista vazia. A tela mostra
 * "Nenhuma área" e o ADMIN associa depois pelo PUT.
 */
export async function assignToCreatedChannel(
  sectorChannel: Pick<SectorChannelService, 'assign'>,
  logger: Pick<Logger, 'warn'>,
  input: Parameters<SectorChannelService['assign']>[0],
): Promise<ChannelSector[]> {
  try {
    return (await sectorChannel.assign(input)).sectors;
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    const reason = typeof code === 'string' ? code : (err as Error).name;
    logger.warn(
      `Número ${input.channelId} criado, mas as áreas não foram associadas (${reason}); o ADMIN pode associar pela tela.`,
    );
    return [];
  }
}

/**
 * Número por área (C1). `Sector.channelId` guarda a associação: uma área tem no
 * máximo um número, então associar uma área já ligada a outro número a MOVE.
 * Quem chama decide se pergunta antes (D16); aqui o servidor só executa, e a
 * rota é do ADMIN.
 */
@Injectable()
export class SectorChannelService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Valida as áreas ANTES de qualquer efeito no provedor (criar a conexão).
   * Devolve os ids sem repetição; área inexistente ou inativa dá 422
   * `channel.sector_invalid`. Não grava nada.
   */
  async assertAssignable(sectorIds: readonly string[]): Promise<string[]> {
    const unique = [...new Set(sectorIds)];
    await this.loadActiveSectors(this.prisma, unique);
    return unique;
  }

  /**
   * Faz o número atender exatamente `sectorIds`: as que vieram entram (saindo
   * do número anterior, se havia), as que estavam e não vieram ficam sem
   * número. Tudo numa transação; a auditoria sai depois, só com ids.
   */
  async assign(input: {
    channelId: string;
    sectorIds: readonly string[];
    actorId: string;
  }): Promise<ChannelSectorsResult> {
    const { channelId, actorId } = input;
    const sectorIds = [...new Set(input.sectorIds)];

    const result = await this.prisma.$transaction(async (tx) => {
      await this.lockChannel(tx, channelId);
      await this.assertTeamChannel(tx, channelId);
      const wanted = await this.loadActiveSectors(tx, sectorIds);
      const moved = wanted.flatMap((s) =>
        s.channelId && s.channelId !== channelId
          ? [{ sectorId: s.id, fromChannelId: s.channelId }]
          : [],
      );
      await tx.sector.updateMany({
        where: { channelId, id: { notIn: sectorIds } },
        data: { channelId: null },
      });
      if (sectorIds.length > 0) {
        await tx.sector.updateMany({
          where: { id: { in: sectorIds } },
          data: { channelId },
        });
      }
      const sectors = wanted.map(({ id, name }) => ({ id, name }));
      return { channelId, sectors, moved };
    });

    await this.audit.log('channel.sectors_update', 'Channel', channelId, {
      channelId,
      sectorIds,
      moved: result.moved,
      actorId,
    });
    return result;
  }

  /** Áreas ativas de cada número, por nome; número sem áreas vem com lista vazia. */
  async sectorsByChannel(
    channelIds: readonly string[],
  ): Promise<Map<string, ChannelSector[]>> {
    const byChannel = new Map<string, ChannelSector[]>(
      channelIds.map((id) => [id, []]),
    );
    if (channelIds.length === 0) return byChannel;
    const rows = await this.prisma.sector.findMany({
      where: { channelId: { in: [...channelIds] }, isActive: true },
      select: { id: true, name: true, channelId: true },
      orderBy: { name: 'asc' },
    });
    for (const row of rows) {
      byChannel
        .get(row.channelId as string)
        ?.push({ id: row.id, name: row.name });
    }
    return byChannel;
  }

  /**
   * Trava a linha do número até o fim da transação. Em READ COMMITTED, duas
   * associações simultâneas ao mesmo número limpam só o que cada uma enxerga e
   * deixariam a união das duas listas; com a trava, a segunda espera a primeira
   * e parte do estado já gravado. A tabela de `Channel` é `"WhatsappInstance"`.
   */
  private async lockChannel(
    tx: Prisma.TransactionClient,
    channelId: string,
  ): Promise<void> {
    await tx.$queryRaw`SELECT id FROM "WhatsappInstance" WHERE id = ${channelId} FOR UPDATE`;
  }

  private async assertTeamChannel(
    db: Prisma.TransactionClient,
    channelId: string,
  ): Promise<void> {
    const channel = await db.channel.findUnique({
      where: { id: channelId },
      select: SECTOR_CHANNEL_SELECT,
    });
    if (!channel) throw new InstanceNotFoundError(channelId);
    if (!effectiveChannel(channel)) throw sectorsNotTeam();
  }

  private async loadActiveSectors(
    db: Pick<Prisma.TransactionClient, 'sector'>,
    sectorIds: readonly string[],
  ) {
    if (sectorIds.length === 0) return [];
    const rows = await db.sector.findMany({
      where: { id: { in: [...sectorIds] }, isActive: true },
      select: { id: true, name: true, channelId: true },
      orderBy: { name: 'asc' },
    });
    if (rows.length !== sectorIds.length) throw sectorInvalid();
    return rows;
  }
}
