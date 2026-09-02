import { describe, it, expect, beforeEach } from 'vitest';
import { mockDeep, type MockProxy } from 'vitest-mock-extended';
import { TemplatesRepository } from './templates.repository';
import { PrismaService } from '../../shared/prisma/prisma.service';

/**
 * Each method is a thin delegate over Prisma — verify the call shape
 * Prisma receives. Strict equality against the where/data clauses keeps
 * a regression that would silently scope queries differently from spec.
 */
describe('TemplatesRepository', () => {
  let repo: TemplatesRepository;
  let prisma: MockProxy<PrismaService>;

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    repo = new TemplatesRepository(prisma);
  });

  it('findById calls prisma.template.findUnique with where.id', async () => {
    prisma.template.findUnique.mockResolvedValue(null);
    await repo.findById('t1');
    expect(prisma.template.findUnique).toHaveBeenCalledWith({
      where: { id: 't1' },
    });
  });

  // ZC — `metaName` deixou de ser @unique GLOBAL (o catálogo é POR WABA), então
  // isto virou findFirst. Continua sendo a checagem de duplicidade dos templates
  // sem canal.
  it('findByMetaName busca por metaName (findFirst — não há mais unique global)', async () => {
    prisma.template.findFirst.mockResolvedValue(null);
    await repo.findByMetaName('boas_vindas');
    expect(prisma.template.findFirst).toHaveBeenCalledWith({
      where: { metaName: 'boas_vindas' },
    });
  });

  // A identidade REAL de um template de canal — a chave do @@unique, e a chave
  // do upsert idempotente do sync.
  it('findByChannelAndName usa a chave composta (provider, channelId, metaName, language)', async () => {
    prisma.template.findUnique.mockResolvedValue(null);
    await repo.findByChannelAndName({
      provider: 'ZERNIO' as never,
      channelId: 'ch_1',
      metaName: 'boas_vindas',
      language: 'pt_BR',
    });
    expect(prisma.template.findUnique).toHaveBeenCalledWith({
      where: {
        provider_channelId_metaName_language: {
          provider: 'ZERNIO',
          channelId: 'ch_1',
          metaName: 'boas_vindas',
          language: 'pt_BR',
        },
      },
    });
  });

  // Rodar o sync duas vezes não pode duplicar nem criar row nova: a chave
  // composta é o que torna o upsert idempotente.
  it('upsertZernioTemplate faz upsert pela chave composta, com provider ZERNIO', async () => {
    prisma.template.upsert.mockResolvedValue({} as never);
    await repo.upsertZernioTemplate({
      channelId: 'ch_1',
      metaName: 'boas_vindas',
      language: 'pt_BR',
      data: {
        body: 'oi',
        variables: [],
        status: 'APPROVED',
        category: 'MARKETING',
        zernioTemplateId: '833669913010819',
      } as never,
    });

    expect(prisma.template.upsert).toHaveBeenCalledWith({
      where: {
        provider_channelId_metaName_language: {
          provider: 'ZERNIO',
          channelId: 'ch_1',
          metaName: 'boas_vindas',
          language: 'pt_BR',
        },
      },
      create: expect.objectContaining({
        provider: 'ZERNIO',
        channelId: 'ch_1',
        metaName: 'boas_vindas',
        language: 'pt_BR',
        zernioTemplateId: '833669913010819',
      }),
      update: expect.objectContaining({ zernioTemplateId: '833669913010819' }),
    });
  });

  it('listAll orders by createdAt desc', async () => {
    prisma.template.findMany.mockResolvedValue([] as never);
    await repo.listAll();
    expect(prisma.template.findMany).toHaveBeenCalledWith({
      where: undefined,
      orderBy: { createdAt: 'desc' },
    });
  });

  it('listAll filters by provider when given', async () => {
    prisma.template.findMany.mockResolvedValue([] as never);
    await repo.listAll('TWILIO' as never);
    expect(prisma.template.findMany).toHaveBeenCalledWith({
      where: { provider: 'TWILIO' },
      orderBy: { createdAt: 'desc' },
    });
  });

  // Sem o unique global de `metaName` não há mais chave de UMA coluna para um
  // upsert do Prisma — daí o find-then-write. O escopo `channelId: null` importa:
  // o catálogo da organização não pode "adotar" (nem sobrescrever) um template
  // que pertence a um canal.
  it('upsertByMetaName cria quando não existe template sem canal com aquele nome', async () => {
    prisma.template.findFirst.mockResolvedValue(null);
    prisma.template.create.mockResolvedValue({} as never);

    await repo.upsertByMetaName({
      metaName: 'mname',
      language: 'pt_BR',
      body: 'hello',
      variables: [],
      status: 'APPROVED',
      category: 'UTILITY',
    } as never);

    expect(prisma.template.findFirst).toHaveBeenCalledWith({
      where: { metaName: 'mname', channelId: null },
    });
    expect(prisma.template.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ metaName: 'mname', body: 'hello' }),
    });
  });

  it('upsertByMetaName atualiza a row existente pelo id, sem reescrever metaName', async () => {
    prisma.template.findFirst.mockResolvedValue({ id: 't1' } as never);
    prisma.template.update.mockResolvedValue({} as never);

    await repo.upsertByMetaName({
      metaName: 'mname',
      language: 'pt_BR',
      body: 'hello',
      variables: [],
      status: 'APPROVED',
      category: 'UTILITY',
    } as never);

    expect(prisma.template.create).not.toHaveBeenCalled();
    const call = prisma.template.update.mock.calls[0][0] as Record<
      string,
      Record<string, unknown>
    >;
    expect(call.where).toEqual({ id: 't1' });
    expect(call.data).toMatchObject({ body: 'hello' });
    expect(call.data).not.toHaveProperty('metaName');
  });

  it('create forwards data straight to prisma.template.create', async () => {
    prisma.template.create.mockResolvedValue({} as never);
    const data = {
      metaName: 'x',
      language: 'pt_BR',
      body: 'b',
      variables: [],
      status: 'APPROVED',
      category: 'UTILITY',
      kind: 'TEXT',
    } as never;
    await repo.create(data);
    expect(prisma.template.create).toHaveBeenCalledWith({ data });
  });

  it('update forwards id + data to prisma.template.update', async () => {
    prisma.template.update.mockResolvedValue({} as never);
    const data = { language: 'en_US' } as never;
    await repo.update('t1', data);
    expect(prisma.template.update).toHaveBeenCalledWith({
      where: { id: 't1' },
      data,
    });
  });

  it('delete calls prisma.template.delete with where.id', async () => {
    prisma.template.delete.mockResolvedValue({} as never);
    await repo.delete('t1');
    expect(prisma.template.delete).toHaveBeenCalledWith({
      where: { id: 't1' },
    });
  });

  it('findInUseByCampaigns counts campaigns referencing the templateId', async () => {
    prisma.campaign.count.mockResolvedValue(5);
    const result = await repo.findInUseByCampaigns('t1');
    expect(prisma.campaign.count).toHaveBeenCalledWith({
      where: { templateId: 't1' },
    });
    expect(result).toBe(5);
  });

  // twilio-platform T4 — campanha ATIVA = rodando/na fila OU agendada
  // (recorrência habilitada com próxima execução, não cancelada).
  it('countActiveCampaignsUsingTemplate conta QUEUED/RUNNING ou agendadas', async () => {
    prisma.campaign.count.mockResolvedValue(2);
    const result = await repo.countActiveCampaignsUsingTemplate('t1');
    expect(prisma.campaign.count).toHaveBeenCalledWith({
      where: {
        templateId: 't1',
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
    expect(result).toBe(2);
  });

  describe('listActiveZernioAccounts', () => {
    // ZC — o `id` do canal passou a ser obrigatório no select: ele é parte da
    // chave única do template (o catálogo é POR WABA). Sem ele, o sync do 2º
    // canal sobrescreveria o template homônimo do 1º.
    it('queries active ZERNIO channels with a zernioAccountId, selecting channel id + accountId + name', async () => {
      prisma.channel.findMany.mockResolvedValue([
        { id: 'ch_1', zernioAccountId: 'acc_1', name: 'Canal 1' },
        { id: 'ch_2', zernioAccountId: 'acc_2', name: 'Canal 2' },
      ] as never);

      const result = await repo.listActiveZernioAccounts();

      expect(prisma.channel.findMany).toHaveBeenCalledWith({
        where: {
          provider: 'ZERNIO',
          isActive: true,
          zernioAccountId: { not: null },
        },
        select: { id: true, zernioAccountId: true, name: true },
      });
      expect(result).toEqual([
        { id: 'ch_1', zernioAccountId: 'acc_1', name: 'Canal 1' },
        { id: 'ch_2', zernioAccountId: 'acc_2', name: 'Canal 2' },
      ]);
    });

    it('returns an empty array when there are no active Zernio channels', async () => {
      prisma.channel.findMany.mockResolvedValue([] as never);
      const result = await repo.listActiveZernioAccounts();
      expect(result).toEqual([]);
    });
  });

  it('findByTwilioContentSid queries by twilioContentSid (findFirst — coluna não é unique)', async () => {
    prisma.template.findFirst.mockResolvedValue(null);
    await repo.findByTwilioContentSid('HX00000000000000000000000000000001');
    expect(prisma.template.findFirst).toHaveBeenCalledWith({
      where: { twilioContentSid: 'HX00000000000000000000000000000001' },
    });
  });

  describe('markTwilioRemoved', () => {
    it('rejeita templates TWILIO cujo sid não voltou da Twilio, idempotente', async () => {
      prisma.template.updateMany.mockResolvedValue({ count: 2 } as never);
      const syncedAt = new Date('2026-07-11T00:00:00Z');

      const count = await repo.markTwilioRemoved(
        ['HX00000000000000000000000000000001'],
        syncedAt,
      );

      expect(prisma.template.updateMany).toHaveBeenCalledWith({
        where: {
          provider: 'TWILIO',
          twilioContentSid: {
            not: null,
            notIn: ['HX00000000000000000000000000000001'],
          },
          NOT: {
            status: 'REJECTED',
            twilioRejectionReason: 'Template removido na Twilio',
          },
        },
        data: {
          status: 'REJECTED',
          twilioRejectionReason: 'Template removido na Twilio',
          lastTwilioSyncAt: syncedAt,
        },
      });
      expect(count).toBe(2);
    });
  });
});
