// backend/src/modules/whatsapp-providers/whatsapp-providers.repository.ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../shared/prisma/prisma.service';
import type { WhatsappConnectionEvent } from '@prisma/client';

export type ConnectionEventRow = Pick<
  WhatsappConnectionEvent,
  'id' | 'instanceId' | 'state' | 'reasonCode' | 'occurredAt'
>;

@Injectable()
export class WhatsappProvidersRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Most-recent event for the instance (any state). Used for dedup in WebhooksService. */
  async findLastEvent(instanceId: string): Promise<ConnectionEventRow | null> {
    return this.prisma.whatsappConnectionEvent.findFirst({
      where: { instanceId },
      orderBy: { occurredAt: 'desc' },
    });
  }

  /** Insert a new connection event row. */
  async createEvent(data: {
    instanceId: string;
    state: string;
    reasonCode: number | null | undefined;
    occurredAt: Date;
  }): Promise<ConnectionEventRow> {
    return this.prisma.whatsappConnectionEvent.create({
      data: {
        instanceId: data.instanceId,
        state: data.state,
        reasonCode: data.reasonCode ?? null,
        occurredAt: data.occurredAt,
      },
    });
  }

  /**
   * O estado MAIS RECENTE de cada canal, num único round trip — usado pelo
   * resumo de GET /whatsapp/providers (item "conectado/desconectado" da tela
   * Canais). Um `findLastEvent` por canal viraria N+1 nessa listagem;
   * `distinct: ['instanceId']` + `orderBy: occurredAt desc` devolve a
   * primeira linha de cada grupo, isto é, a mais recente por canal.
   *
   * Só EVOLUTION e GOZAP (sessionBased) gravam `WhatsappConnectionEvent` —
   * um canal TWILIO/ZERNIO/META, ou um canal sessionBased que nunca concluiu
   * um ciclo de conexão, simplesmente não aparece no Map. O chamador trata a
   * ausência como "sem informação", nunca como "desconectado" — inventar um
   * estado seria pior que não mostrar nada.
   */
  async lastStateByInstanceIds(
    instanceIds: string[],
  ): Promise<Map<string, string>> {
    if (instanceIds.length === 0) return new Map();
    const rows = await this.prisma.whatsappConnectionEvent.findMany({
      where: { instanceId: { in: instanceIds } },
      orderBy: { occurredAt: 'desc' },
      distinct: ['instanceId'],
      select: { instanceId: true, state: true },
    });
    return new Map(rows.map((r) => [r.instanceId, r.state]));
  }

  /**
   * Delete all events with occurredAt before `cutoff`. Returns number of deleted rows.
   * Called by the daily cleanup job (7-day retention).
   */
  async deleteOldEvents(cutoff: Date): Promise<number> {
    const result = await this.prisma.whatsappConnectionEvent.deleteMany({
      where: { occurredAt: { lt: cutoff } },
    });
    return result.count;
  }
}
