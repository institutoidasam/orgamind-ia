import { PrismaClient } from '@prisma/client';
import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
  vi,
} from 'vitest';
import { mockDeep } from 'vitest-mock-extended';
import type { Queue } from 'bullmq';
import type { ClsService } from 'nestjs-cls';
import { CampaignsService } from './campaigns.service';
import { CampaignsRepository } from './campaigns.repository';
import { SegmentsRepository } from '../segments/segments.repository';
import { TemplatesRepository } from '../templates/templates.repository';
import { WhatsappInstancesRepository } from '../whatsapp-instances/whatsapp-instances.repository';
import { CampaignBatchSizeExceedsPendingError } from './errors/campaigns.errors';
import { AuditService } from '../../shared/audit/audit.service';
import { ConsentService } from '../consent/consent.service';
import { PrismaService } from '../../shared/prisma/prisma.service';
import type { SendMessageJob } from '../queue/queue.constants';
import {
  assertTestDatabase,
  shouldRunDbTests,
} from '../../../test/require-test-db';

/**
 * A.7 — O CICLO COMPLETO, CONTRA UM BANCO DE VERDADE.
 *
 * Criar → 1º lote → "Restam" cai → próximo lote → teto atingido (o lote
 * excedente fica em fila) → cancelar → "Em fila" zera.
 *
 * Por que contra banco real e não com Prisma mockado: o valor deste teste está
 * exatamente no que o mock apaga — o `where` de verdade. `pendingAudienceWhere`
 * é um `messages: { none: … }` correlacionado, e é ele que decide se o 2º lote
 * repete ou não as pessoas do 1º. Com mock, "Restam cai" seria uma tautologia.
 */
const RUN_DB_TESTS = shouldRunDbTests();

if (!RUN_DB_TESTS) {
  console.warn(
    '[campaigns.batches.e2e.spec] PULANDO: PICOA_DB_TESTS não está setada. Este spec escreve ' +
      'num Postgres real. Para rodar de propósito: PICOA_DB_TESTS=1 ' +
      'DATABASE_URL=postgresql://.../picoa_test bunx vitest run campaigns.batches.e2e.spec',
  );
}

const prisma = new PrismaClient();

async function resetDb() {
  assertTestDatabase();
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "Message", "CampaignBatch", "Campaign", "Template",
      "Contact", "WhatsappInstance",
      "AuditEvent",
      "ConsentEvent", "ContactConsent", "SuppressionList",
      "ConsentText", "ConsentPurpose"
    RESTART IDENTITY CASCADE;
  `);
}

describe.skipIf(!RUN_DB_TESTS)(
  'A.7 — campanha em lotes (integração; requer banco de teste real)',
  () => {
    let service: CampaignsService;
    let sendQueue: ReturnType<typeof mockDeep<Queue<SendMessageJob>>>;

    beforeAll(() => {
      assertTestDatabase();
    });

    afterAll(async () => {
      await prisma.$disconnect();
    });

    beforeEach(async () => {
      await resetDb();

      await prisma.consentPurpose.create({
        data: { key: 'campanha', label: 'Campanha', description: '' },
      });
      await prisma.channel.create({
        data: {
          id: 'chan1',
          name: 'robo',
          evolutionInstanceName: 'robo',
          apiKey: '',
          provider: 'ZERNIO',
          isActive: true,
          isDefault: true,
          dailySendLimit: 500,
        },
      });
      await prisma.template.create({
        data: {
          id: 'tpl1',
          metaName: 'aviso',
          language: 'pt_BR',
          body: 'Olá',
          variables: [],
          status: 'APPROVED',
          provider: 'ZERNIO',
          category: 'MARKETING',
        },
      });
      await prisma.contact.createMany({
        data: Array.from({ length: 12 }, (_, i) => ({
          id: `c${String(i).padStart(3, '0')}`,
          phoneE164: `+55929${String(90000000 + i)}`,
          name: `Eleitor ${i}`,
          optedOut: false,
        })),
      });
      // O gate de consentimento NÃO é o objeto deste teste: `ConsentService`
      // está mockado abaixo devolvendo "todo mundo consentiu". Por isso não há
      // linha de ContactConsent aqui — só a ConsentPurpose, que a FK da
      // Campaign exige.
      await prisma.campaign.create({
        data: {
          id: 'camp1',
          name: 'Aviso',
          templateId: 'tpl1',
          defaultInstanceId: 'chan1',
          filters: { combinator: 'and', rules: [] },
          variableMap: {},
          totalRecipients: 0,
          status: 'DRAFT',
          scheduleType: 'IMMEDIATE',
          scheduleEnabled: false,
          timezone: 'America/Manaus',
          purposeKey: 'campanha',
        },
      });

      const prismaService = prisma as unknown as PrismaService;
      const repo = new CampaignsRepository(prismaService);
      const templatesRepo = new TemplatesRepository(prismaService);
      const instancesRepo = mockDeep<WhatsappInstancesRepository>();
      instancesRepo.findById.mockResolvedValue({
        id: 'chan1',
        provider: 'ZERNIO',
        isActive: true,
        sentToday: 0,
        dailySendLimit: 500,
        sendWindowEnabled: false,
      } as never);
      const segmentsRepo = mockDeep<SegmentsRepository>();
      segmentsRepo.countContactsByWhere.mockResolvedValue(0);
      const audit = mockDeep<AuditService>();
      const cls = mockDeep<ClsService>();
      const consent = mockDeep<ConsentService>();
      consent.suppressedPhones.mockResolvedValue(new Set());
      consent.grantedContactIds.mockImplementation((ids: string[]) =>
        Promise.resolve(new Set(ids)),
      );
      consent.isSensitivePurpose.mockResolvedValue(false);
      consent.findActivePurpose.mockResolvedValue({
        key: 'campanha',
        label: 'Campanha',
        description: '',
        isSensitive: false,
      });
      sendQueue = mockDeep<Queue<SendMessageJob>>();
      // `cancel()` drena os jobs pendentes da fila real (BullMQ) — sem Redis
      // de pé, `getJobs` fica sem valor default e o `for..of` de
      // `drainPendingJobs` quebra em "jobs is not iterable". O mesmo default
      // que `campaigns.service.spec.ts` usa nos testes de `cancel()`.
      sendQueue.getJobs.mockResolvedValue([] as never);
      const redis = {
        set: vi.fn().mockResolvedValue('OK'),
        del: vi.fn().mockResolvedValue(1),
        eval: vi.fn().mockResolvedValue(1),
      };

      service = new CampaignsService(
        repo,
        segmentsRepo,
        templatesRepo,
        instancesRepo,
        sendQueue,
        audit,
        cls,
        redis as never,
        consent,
        prismaService,
      );
    });

    it('criar → 1º lote → restam cai → 2º lote → cancelar → em fila zera', async () => {
      // 1) O público inteiro está pendente e nada foi enviado.
      const antes = await service.batchSummary('camp1');
      expect(antes.total).toBe(12);
      expect(antes.pending).toBe(12);
      expect(antes.sent).toBe(0);
      expect(antes.inFlight).toBe(0);

      // 2) 1º lote de 5: "Restam" cai para 7 e cinco mensagens estão em voo.
      const lote1 = await service.sendBatch('camp1', 5);
      expect(lote1.queued).toBe(5);
      expect(lote1.summary.pending).toBe(7);
      expect(lote1.summary.inFlight).toBe(5);

      // 3) 2º lote de 7: ninguém repete — os 12 contatos distintos foram cobertos.
      const lote2 = await service.sendBatch('camp1', 7);
      expect(lote2.queued).toBe(7);
      expect(lote2.summary.pending).toBe(0);
      const contatosComMensagem = await prisma.message.groupBy({
        by: ['contactId'],
        where: { campaignId: 'camp1' },
      });
      expect(contatosComMensagem).toHaveLength(12);

      // 4) Sem ninguém pendente, um lote novo é recusado (a recusa por TAMANHO
      //    tem teste próprio logo abaixo, com público ainda restando).
      await expect(service.sendBatch('camp1', 3)).rejects.toBeInstanceOf(Error);

      // 5) Cancelar: as mensagens em fila viram CANCELLED e "Em fila" zera.
      await service.cancel('camp1');
      const depois = await service.batchSummary('camp1');
      expect(depois.inFlight).toBe(0);
      expect(depois.waiting).toBe(0);
      expect(depois.status).toBe('CANCELLED');
    });

    it('pedir mais do que resta recusa com a contagem, sem criar lote', async () => {
      await service.sendBatch('camp1', 10);
      const lotesAntes = await prisma.campaignBatch.count({
        where: { campaignId: 'camp1' },
      });

      await expect(service.sendBatch('camp1', 5)).rejects.toBeInstanceOf(
        CampaignBatchSizeExceedsPendingError,
      );

      const lotesDepois = await prisma.campaignBatch.count({
        where: { campaignId: 'camp1' },
      });
      expect(lotesDepois).toBe(lotesAntes);
    });

    /**
     * REGRESSÃO — a exclusão automática de mesmo template continua valendo em
     * lotes: quem já está em campanha VIVA com o mesmo template não entra no
     * público de uma campanha nova, por mais lotes que se mande.
     */
    it('a exclusão de mesmo template continua valendo em lotes', async () => {
      await service.sendBatch('camp1', 6);

      await prisma.campaign.create({
        data: {
          id: 'camp2',
          name: 'Aviso 2',
          templateId: 'tpl1',
          defaultInstanceId: 'chan1',
          filters: { combinator: 'and', rules: [] },
          variableMap: {},
          totalRecipients: 0,
          status: 'DRAFT',
          scheduleType: 'IMMEDIATE',
          scheduleEnabled: false,
          timezone: 'America/Manaus',
          purposeKey: 'campanha',
        },
      });

      const resumo2 = await service.batchSummary('camp2');
      // Os 6 já em voo na camp1 estão fora do público da camp2.
      expect(resumo2.total).toBe(6);
      expect(resumo2.pending).toBe(6);
    });
  },
);
