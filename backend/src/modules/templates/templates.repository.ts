import { Injectable } from '@nestjs/common';
import { Prisma, type Template, type ChannelProvider } from '@prisma/client';
import { PrismaService } from '../../shared/prisma/prisma.service';

/**
 * Rejection reason stamped on provider=TWILIO templates whose Content SID is
 * no longer returned by the Twilio catalog (deleted at Twilio). Shared with
 * the template-approval-sync processor.
 */
export const TWILIO_REMOVED_REASON = 'Template removido na Twilio';

export type TemplateCreateData = Omit<
  Prisma.TemplateUncheckedCreateInput,
  'id' | 'createdAt'
>;

export type TemplateUpdateData = Omit<
  Prisma.TemplateUncheckedUpdateInput,
  'id' | 'metaName' | 'createdAt'
>;

@Injectable()
export class TemplatesRepository {
  constructor(private readonly prisma: PrismaService) {}

  findById(id: string): Promise<Template | null> {
    return this.prisma.template.findUnique({ where: { id } });
  }

  /**
   * ZC — `metaName` deixou de ser @unique GLOBAL (o catálogo é POR WABA: duas
   * contas podem ter um `boas_vindas` cada), então isto virou um findFirst.
   *
   * Continua sendo a checagem de duplicidade dos templates SEM canal (criação
   * manual / catálogo da organização), que é onde o unique global de fato
   * protegia alguma coisa. Um template de canal (Zernio) tem a identidade
   * completa — use {@link findByChannelAndName}.
   */
  findByMetaName(metaName: string): Promise<Template | null> {
    return this.prisma.template.findFirst({ where: { metaName } });
  }

  /**
   * A identidade REAL de um template de canal: (provider, channelId, metaName,
   * language) — a chave do @@unique. É por ela que o sync faz upsert idempotente
   * e que o webhook `template.status_updated` acha a row (a Meta manda nome +
   * idioma, não o nosso id).
   */
  findByChannelAndName(args: {
    provider: ChannelProvider;
    channelId: string;
    metaName: string;
    language: string;
  }): Promise<Template | null> {
    return this.prisma.template.findUnique({
      where: { provider_channelId_metaName_language: args },
    });
  }

  listAll(provider?: ChannelProvider): Promise<Template[]> {
    return this.prisma.template.findMany({
      where: provider ? { provider } : undefined,
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Upsert do catálogo SEM canal (sync da Meta/organização). Com o unique global
   * de `metaName` derrubado (ZC), não há mais chave única de uma coluna só para
   * um `upsert` do Prisma — daí o find-then-write. A corrida é irrelevante aqui:
   * o único escritor é o job de sync, com concurrency 1.
   */
  async upsertByMetaName(
    data: Prisma.TemplateCreateInput & { metaName: string },
  ): Promise<Template> {
    const { metaName, ...rest } = data;
    const existing = await this.prisma.template.findFirst({
      where: { metaName, channelId: null },
    });
    return existing
      ? this.prisma.template.update({ where: { id: existing.id }, data: rest })
      : this.prisma.template.create({ data: { metaName, ...rest } });
  }

  /**
   * ZC — upsert idempotente do catálogo de UM canal Zernio, casando pela chave
   * composta. Rodar o sync duas vezes não duplica nem cria row nova.
   */
  async upsertZernioTemplate(args: {
    channelId: string;
    metaName: string;
    language: string;
    data: Omit<
      Prisma.TemplateUncheckedCreateInput,
      'id' | 'createdAt' | 'channelId' | 'metaName' | 'language' | 'provider'
    >;
  }): Promise<Template> {
    const { channelId, metaName, language, data } = args;
    return this.prisma.template.upsert({
      where: {
        provider_channelId_metaName_language: {
          provider: 'ZERNIO',
          channelId,
          metaName,
          language,
        },
      },
      create: {
        ...data,
        provider: 'ZERNIO',
        channelId,
        metaName,
        language,
      },
      update: data,
    });
  }

  create(data: TemplateCreateData): Promise<Template> {
    return this.prisma.template.create({ data });
  }

  update(id: string, data: TemplateUpdateData): Promise<Template> {
    return this.prisma.template.update({ where: { id }, data });
  }

  delete(id: string): Promise<Template> {
    return this.prisma.template.delete({ where: { id } });
  }

  /**
   * Returns the number of campaigns referencing this template. Used to
   * refuse deletion when the template is in use.
   */
  findInUseByCampaigns(id: string): Promise<number> {
    return this.prisma.campaign.count({ where: { templateId: id } });
  }

  /**
   * Campanhas ATIVAS que usam o template (twilio-platform T4): em execução
   * (RUNNING), na fila (QUEUED) ou agendadas — recorrência habilitada com
   * próxima execução marcada, exceto canceladas. Excluir um Content template
   * em uso quebraria os envios agendados (dossiê §3.1), então o DELETE é
   * bloqueado enquanto houver alguma.
   */
  countActiveCampaignsUsingTemplate(id: string): Promise<number> {
    return this.prisma.campaign.count({
      where: {
        templateId: id,
        OR: [
          { status: { in: ['QUEUED', 'RUNNING'] } },
          {
            scheduleEnabled: true,
            nextRunAt: { not: null },
            status: { notIn: ['CANCELLED'] },
          },
        ],
      },
    });
  }

  /**
   * Lookup by Twilio Content SID (`HX…`). `twilioContentSid` is not a unique
   * column in the schema, so this is a findFirst — the approval-sync job is
   * the only writer creating rows with a sid, keeping it 1:1 in practice.
   */
  findByTwilioContentSid(sid: string): Promise<Template | null> {
    return this.prisma.template.findFirst({
      where: { twilioContentSid: sid },
    });
  }

  /**
   * Marks provider=TWILIO templates whose Content SID was NOT returned by the
   * Twilio catalog as REJECTED ("removido na Twilio"). Idempotent: rows
   * already carrying that exact status+reason are left alone, so the 2-min
   * sync doesn't rewrite them forever. Returns how many rows were marked.
   */
  async markTwilioRemoved(seenSids: string[], syncedAt: Date): Promise<number> {
    const { count } = await this.prisma.template.updateMany({
      where: {
        provider: 'TWILIO',
        twilioContentSid: { not: null, notIn: seenSids },
        NOT: {
          status: 'REJECTED',
          twilioRejectionReason: TWILIO_REMOVED_REASON,
        },
      },
      data: {
        status: 'REJECTED',
        twilioRejectionReason: TWILIO_REMOVED_REASON,
        lastTwilioSyncAt: syncedAt,
      },
    });
    return count;
  }

  /**
   * Active ZERNIO channels that have an accountId configured — one Zernio
   * template sync fetch per account (see TemplatesService.syncFromZernio).
   * Channels without a zernioAccountId (mid-setup) or inactive/soft-deleted
   * ones are excluded.
   *
   * ZC — devolve também o `id` do canal: o catálogo é POR WABA, e o `channelId`
   * é parte da chave única do template (sem ele, o sync do 2º canal
   * sobrescreveria o template homônimo do 1º).
   */
  listActiveZernioAccounts(): Promise<
    Array<{ id: string; zernioAccountId: string; name: string }>
  > {
    return this.prisma.channel.findMany({
      where: {
        provider: 'ZERNIO',
        isActive: true,
        zernioAccountId: { not: null },
      },
      select: { id: true, zernioAccountId: true, name: true },
    }) as Promise<Array<{ id: string; zernioAccountId: string; name: string }>>;
  }

  /**
   * ZB — O CANAL (WABA) em que um template Zernio vai ser criado.
   *
   * O `accountId` do Zernio é OBRIGATÓRIO no POST, e o catálogo é POR WABA — daí
   * a criação exigir `channelId`. Sem ele a row nasceria órfã (channelId=null) e
   * o primeiro `syncFromZernio` criaria uma SEGUNDA row do mesmo template (a
   * chave única é `(provider, channelId, metaName, language)`).
   *
   * Canal inativo/soft-deleted ou sem conta não serve: criar um template numa
   * WABA que não está em uso é gastar 24h de fila da Meta à toa.
   */
  findZernioChannel(
    channelId: string,
  ): Promise<{ id: string; zernioAccountId: string; name: string } | null> {
    return this.prisma.channel.findFirst({
      where: {
        id: channelId,
        provider: 'ZERNIO',
        isActive: true,
        zernioAccountId: { not: null },
      },
      select: { id: true, zernioAccountId: true, name: true },
    }) as Promise<{ id: string; zernioAccountId: string; name: string } | null>;
  }

  /**
   * ZC — casa o evento `whatsapp.template.status_updated` com a row local.
   *
   * A Meta manda o `templateId` (o message_template_id) — é a chave mais
   * confiável. Mas o webhook às vezes chega ANTES do primeiro sync (ou o
   * template foi criado fora do orgamind), então há o fallback por
   * (canal, nome, idioma), que é a chave que a própria doc recomenda para o
   * upsert deste evento.
   */
  async findZernioTemplate(args: {
    channelId: string;
    zernioTemplateId?: string;
    metaName: string;
    language: string;
  }): Promise<Template | null> {
    if (args.zernioTemplateId) {
      const byId = await this.prisma.template.findFirst({
        where: {
          provider: 'ZERNIO',
          channelId: args.channelId,
          zernioTemplateId: args.zernioTemplateId,
        },
      });
      if (byId) return byId;
    }
    return this.findByChannelAndName({
      provider: 'ZERNIO',
      channelId: args.channelId,
      metaName: args.metaName,
      language: args.language,
    });
  }
}
