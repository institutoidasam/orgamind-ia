import { describe, it, expect, beforeEach } from 'vitest';
import { mockDeep, MockProxy } from 'vitest-mock-extended';
import { ContactsRepository, buildContactListWhere } from './contacts.repository';
import { PrismaService } from '../../shared/prisma/prisma.service';
import {
  REACHED_STATUSES,
  reachedInCampaignFilter,
} from '../campaigns/batch-audience';
import {
  DELIVERY_PROVEN_STATUSES,
  excludeInvalidWhere,
  invalidContactWhere,
  unvalidatedContactWhere,
  validContactWhere,
} from '../../shared/contact-validity';

describe('ContactsRepository', () => {
  let repo: ContactsRepository;
  let prisma: MockProxy<PrismaService>;

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    repo = new ContactsRepository(prisma);
  });

  describe('lookups', () => {
    it('findById delegates to prisma', async () => {
      prisma.contact.findUnique.mockResolvedValue(null);
      await repo.findById('c1');
      expect(prisma.contact.findUnique).toHaveBeenCalledWith({
        where: { id: 'c1' },
      });
    });

    // C5 — a IDENTIDADE do contato é o assinante do WhatsApp, não a string.
    // `+5592995550101` e `+559295550101` são a MESMA conta; procurar por
    // igualdade exata é o que faz a mesma pessoa virar duas linhas.
    it('findByAnyBrForm procura pelas DUAS grafias do 9º dígito', async () => {
      prisma.contact.findMany.mockResolvedValue([] as never);
      await repo.findByAnyBrForm('+559295550101');
      expect(prisma.contact.findMany).toHaveBeenCalledWith({
        where: { phoneE164: { in: ['+559295550101', '+5592995550101'] } },
        take: 2,
      });
    });

    it('findByAnyBrForm devolve a linha com a grafia JÁ GRAVADA, não a consultada', async () => {
      prisma.contact.findMany.mockResolvedValue([
        { id: 'c1', phoneE164: '+5592995550101' },
      ] as never);
      const found = await repo.findByAnyBrForm('+559295550101');
      expect(found?.phoneE164).toBe('+5592995550101');
    });

    // Enquanto a base ainda tem gêmeos (o merge roda a cada deploy, mas um
    // import pode criar um par entre dois deploys), a escolha não pode depender
    // da ordem que o Postgres devolveu: quem manda é a forma de 13 dígitos —
    // a MESMA canônica que o script de fusão elege.
    it('findByAnyBrForm prefere DETERMINISTICAMENTE a forma de 13 dígitos quando as duas existem', async () => {
      prisma.contact.findMany.mockResolvedValue([
        { id: 'c-legado', phoneE164: '+559295550101' },
        { id: 'c-moderno', phoneE164: '+5592995550101' },
      ] as never);
      const found = await repo.findByAnyBrForm('+559295550101');
      expect(found?.id).toBe('c-moderno');
    });

    it('linkConversationsByPhone attaches unlinked conversations matching any phone variant and returns the count', async () => {
      prisma.conversation.updateMany.mockResolvedValue({ count: 2 } as never);
      const linked = await repo.linkConversationsByPhone('ct1', [
        '+5592995550101',
        '+559295550101',
      ]);
      expect(prisma.conversation.updateMany).toHaveBeenCalledWith({
        where: {
          contactId: null,
          phoneE164: { in: ['+5592995550101', '+559295550101'] },
        },
        data: { contactId: 'ct1' },
      });
      expect(linked).toBe(2);
    });
  });

  describe('listPaginated', () => {
    it('computes skip/take and runs in a transaction', async () => {
      prisma.$transaction.mockResolvedValue([[], 0] as never);

      await repo.listPaginated({ page: 2, pageSize: 25 });

      expect(prisma.contact.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          skip: 25,
          take: 25,
          orderBy: { createdAt: 'desc' },
          where: {},
        }),
      );
      expect(prisma.contact.count).toHaveBeenCalled();
    });

    it('search produces a phoneE164 OR name filter', async () => {
      prisma.$transaction.mockResolvedValue([[], 0] as never);
      await repo.listPaginated({ page: 1, pageSize: 10, search: 'Ana' });
      expect(prisma.contact.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            OR: [
              { phoneE164: { contains: 'Ana' } },
              { name: { contains: 'Ana', mode: 'insensitive' } },
            ],
          },
        }),
      );
    });

    it('city, group and optedOut filters land on `where`', async () => {
      prisma.$transaction.mockResolvedValue([[], 0] as never);
      await repo.listPaginated({
        page: 1,
        pageSize: 10,
        city: 'Manaus',
        group: 'alunos',
        optedOut: true,
      });
      expect(prisma.contact.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { city: 'Manaus', group: 'alunos', optedOut: true },
        }),
      );
    });

    // F2 T6 — a tela de contatos filtra por "última falha definitiva"
    // (Contact.lastFailureReason), a mesma coluna que buildContactFailureUpdate
    // grava. Sem este filtro, o operador não consegue segmentar "quem tem
    // telefone inválido" ou "quem optou por sair" fora de uma campanha.
    it('failureReason filters by Contact.lastFailureReason', async () => {
      prisma.$transaction.mockResolvedValue([[], 0] as never);
      await repo.listPaginated({
        page: 1,
        pageSize: 10,
        failureReason: 'TELEFONE_INVALIDO' as never,
      });
      expect(prisma.contact.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { lastFailureReason: 'TELEFONE_INVALIDO' },
        }),
      );
    });

    it('returns the transaction result shape', async () => {
      prisma.$transaction.mockResolvedValue([
        [{ id: 'a', whatsappValid: null, lastFailureReason: null, messages: [] }],
        1,
      ] as never);
      prisma.message.groupBy.mockResolvedValue([] as never);
      const r = await repo.listPaginated({ page: 1, pageSize: 10 });
      expect(r).toEqual({
        items: [
          {
            id: 'a',
            whatsappValid: null,
            lastFailureReason: null,
            campaignsReceived: { count: 0, names: [] },
            validity: 'unvalidated',
          },
        ],
        total: 1,
      });
    });

    // B.6, review (achado 1) — a sonda de entrega vai no MESMO findMany que
    // busca a página: sem ela, `validity` (abaixo) não teria como saber que
    // um contato nunca validado ativamente já foi ENTREGUE de verdade.
    it('inclui a sonda de entrega (DELIVERED/READ, take:1) no findMany da página', async () => {
      prisma.$transaction.mockResolvedValue([[], 0] as never);
      await repo.listPaginated({ page: 1, pageSize: 10 });
      expect(prisma.contact.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          include: {
            messages: {
              where: {
                direction: 'OUTBOUND',
                status: { in: DELIVERY_PROVEN_STATUSES },
              },
              select: { id: true },
              take: 1,
            },
          },
        }),
      );
    });

    // B.6, review (achado 1) — a linha original do bug: `whatsappValid: null`
    // (nunca validado ativamente) mas com uma mensagem DELIVERED/READ. Antes,
    // a coluna "WA" dizia "Não validado" enquanto `?validity=valid` e o N do
    // diálogo de sincronização já contavam esta linha como válida.
    it('whatsappValid null + mensagem entregue (DELIVERED/READ) mapeia para validity: "valid"', async () => {
      prisma.$transaction.mockResolvedValue([
        [
          {
            id: 'c1',
            whatsappValid: null,
            lastFailureReason: null,
            messages: [{ id: 'm1' }],
          },
        ],
        1,
      ] as never);
      prisma.message.groupBy.mockResolvedValue([] as never);

      const r = await repo.listPaginated({ page: 1, pageSize: 10 });

      expect(r.items[0].validity).toBe('valid');
      // A sonda não vaza na resposta.
      expect(r.items[0]).not.toHaveProperty('messages');
    });
  });

  /**
   * "Recebeu a campanha X" só existia na direção campanha→contato (o wizard
   * EXCLUI da audiência quem já recebeu). Aqui é a direção inversa — a lista de
   * contatos mostra, por contato, QUAIS campanhas ele recebeu — e o critério
   * tem de ser o MESMO (`REACHED_STATUSES`), ou a tela diria uma coisa e o
   * disparo faria outra.
   */
  describe('listPaginated — campanhas recebidas por contato', () => {
    it('agrega count + nomes das campanhas recebidas, numa única query de mensagens', async () => {
      prisma.$transaction.mockResolvedValue([
        [{ id: 'c1', messages: [] }],
        1,
      ] as never);
      prisma.message.groupBy.mockResolvedValue([
        { contactId: 'c1', campaignId: 'camp1' },
        { contactId: 'c1', campaignId: 'camp2' },
      ] as never);
      // A ordem da lista é a do findMany (createdAt desc: a mais recente
      // primeiro), porque a coluna trunca e o operador quer ver as últimas.
      prisma.campaign.findMany.mockResolvedValue([
        { id: 'camp2', name: 'Convite' },
        { id: 'camp1', name: 'Boas-vindas' },
      ] as never);

      const r = await repo.listPaginated({ page: 1, pageSize: 10 });

      expect(r.items[0].campaignsReceived).toEqual({
        count: 2,
        names: ['Convite', 'Boas-vindas'],
      });
      expect(prisma.campaign.findMany).toHaveBeenCalledWith({
        where: { id: { in: ['camp1', 'camp2'] } },
        select: { id: true, name: true },
        orderBy: { createdAt: 'desc' },
      });
    });

    it('contato sem campanha nenhuma vem com count 0 e names []', async () => {
      prisma.$transaction.mockResolvedValue([
        [
          { id: 'c1', messages: [] },
          { id: 'c2', messages: [] },
        ],
        2,
      ] as never);
      prisma.message.groupBy.mockResolvedValue([
        { contactId: 'c1', campaignId: 'camp1' },
      ] as never);
      prisma.campaign.findMany.mockResolvedValue([
        { id: 'camp1', name: 'Boas-vindas' },
      ] as never);

      const r = await repo.listPaginated({ page: 1, pageSize: 10 });

      expect(r.items[1].campaignsReceived).toEqual({ count: 0, names: [] });
    });

    it('a agregação exige campaignId NOT NULL e só status alcançados (bot/inbox e FAILED ficam de fora)', async () => {
      // `direction:'OUTBOUND' + status alcançado` sozinho também casa mensagem
      // de BOT/INBOX, que não pertence a campanha nenhuma — sem o
      // `campaignId: { not: null }` o contador contaria conversa como campanha.
      // O mesmo cuidado está em scripts/measure-duplicate-campaign-deliveries.ts.
      prisma.$transaction.mockResolvedValue([
        [{ id: 'c1', messages: [] }],
        1,
      ] as never);
      prisma.message.groupBy.mockResolvedValue([] as never);

      await repo.listPaginated({ page: 1, pageSize: 10 });

      expect(prisma.message.groupBy).toHaveBeenCalledWith({
        by: ['contactId', 'campaignId'],
        where: {
          contactId: { in: ['c1'] },
          campaignId: { not: null },
          direction: 'OUTBOUND',
          status: { in: REACHED_STATUSES },
        },
      });
      expect(REACHED_STATUSES).not.toContain('FAILED');
    });

    it('ignora uma linha agregada com campaignId nulo (defesa em profundidade)', async () => {
      prisma.$transaction.mockResolvedValue([
        [{ id: 'c1', messages: [] }],
        1,
      ] as never);
      prisma.message.groupBy.mockResolvedValue([
        { contactId: 'c1', campaignId: null },
        { contactId: 'c1', campaignId: 'camp1' },
      ] as never);
      prisma.campaign.findMany.mockResolvedValue([
        { id: 'camp1', name: 'Boas-vindas' },
      ] as never);

      const r = await repo.listPaginated({ page: 1, pageSize: 10 });

      expect(r.items[0].campaignsReceived).toEqual({
        count: 1,
        names: ['Boas-vindas'],
      });
    });

    it('resolve a página inteira sem N+1: 1 groupBy + 1 findMany de campanha', async () => {
      const page = Array.from({ length: 25 }, (_, i) => ({
        id: `c${i}`,
        messages: [],
      }));
      prisma.$transaction.mockResolvedValue([page, 25] as never);
      prisma.message.groupBy.mockResolvedValue(
        page.map((c, i) => ({
          contactId: c.id,
          campaignId: `camp${i % 3}`,
        })) as never,
      );
      prisma.campaign.findMany.mockResolvedValue([
        { id: 'camp0', name: 'A' },
        { id: 'camp1', name: 'B' },
        { id: 'camp2', name: 'C' },
      ] as never);

      const r = await repo.listPaginated({ page: 1, pageSize: 25 });

      expect(r.items).toHaveLength(25);
      expect(prisma.message.groupBy).toHaveBeenCalledTimes(1);
      expect(prisma.campaign.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.message.findMany).not.toHaveBeenCalled();
    });

    it('página vazia não dispara query de agregação nenhuma', async () => {
      prisma.$transaction.mockResolvedValue([[], 0] as never);

      await repo.listPaginated({ page: 1, pageSize: 10 });

      expect(prisma.message.groupBy).not.toHaveBeenCalled();
      expect(prisma.campaign.findMany).not.toHaveBeenCalled();
    });

    it('receivedCampaignId filtra por quem RECEBEU aquela campanha — o mesmo predicado do wizard', async () => {
      prisma.$transaction.mockResolvedValue([[], 0] as never);

      await repo.listPaginated({
        page: 1,
        pageSize: 10,
        receivedCampaignId: 'camp1',
      });

      expect(prisma.contact.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { messages: { some: reachedInCampaignFilter('camp1') } },
        }),
      );
      // O predicado reusado É o literal que o filter.converter (F1) já roda em
      // prod para o event:'received' — divergir criaria incoerência visível.
      expect(reachedInCampaignFilter('camp1')).toEqual({
        campaignId: 'camp1',
        direction: 'OUTBOUND',
        status: { in: REACHED_STATUSES },
      });
      // O total tem de contar o MESMO recorte, senão a paginação mente.
      expect(prisma.contact.count).toHaveBeenCalledWith({
        where: { messages: { some: reachedInCampaignFilter('camp1') } },
      });
    });

    it('receivedCampaignId combina com os outros filtros em vez de substituí-los', async () => {
      prisma.$transaction.mockResolvedValue([[], 0] as never);

      await repo.listPaginated({
        page: 1,
        pageSize: 10,
        city: 'Manaus',
        receivedCampaignId: 'camp1',
      });

      expect(prisma.contact.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            city: 'Manaus',
            messages: { some: reachedInCampaignFilter('camp1') },
          },
        }),
      );
    });
  });

  describe('create / update / upsert / delete', () => {
    it('create defaults tags to []', async () => {
      prisma.contact.create.mockResolvedValue({} as never);
      await repo.create({ phoneE164: '+1', name: 'Alice' });
      expect(prisma.contact.create).toHaveBeenCalledWith({
        data: { phoneE164: '+1', name: 'Alice', tags: [] },
      });
    });

    it('create forwards customFields when present', async () => {
      prisma.contact.create.mockResolvedValue({} as never);
      await repo.create({
        phoneE164: '+1',
        tags: ['vip'],
        customFields: { foo: 'bar' },
      });
      expect(prisma.contact.create).toHaveBeenCalledWith({
        data: {
          phoneE164: '+1',
          tags: ['vip'],
          customFields: { foo: 'bar' },
        },
      });
    });

    it('update forwards optedOut and other partial fields', async () => {
      prisma.contact.update.mockResolvedValue({} as never);
      await repo.update('c1', { optedOut: true, name: 'Bob' });
      expect(prisma.contact.update).toHaveBeenCalledWith({
        where: { id: 'c1' },
        data: { optedOut: true, name: 'Bob' },
      });
    });

    it('update preserves customFields when provided', async () => {
      prisma.contact.update.mockResolvedValue({} as never);
      await repo.update('c1', { customFields: { vip: true } });
      expect(prisma.contact.update).toHaveBeenCalledWith({
        where: { id: 'c1' },
        data: { customFields: { vip: true } },
      });
    });

    it('delete delegates to prisma', async () => {
      prisma.contact.delete.mockResolvedValue({} as never);
      await repo.delete('c1');
      expect(prisma.contact.delete).toHaveBeenCalledWith({
        where: { id: 'c1' },
      });
    });
  });

  describe('label + validation persistence', () => {
    it('updateLabels writes the canonical waLabels list', async () => {
      prisma.contact.update.mockResolvedValue({} as never);
      await repo.updateLabels('c1', ['vip', '2026']);
      expect(prisma.contact.update).toHaveBeenCalledWith({
        where: { id: 'c1' },
        data: { waLabels: ['vip', '2026'] },
      });
    });

    it('métodos do fluxo síncrono de validação foram removidos (updateValidation, findManyForValidation)', () => {
      const r = repo as unknown as Record<string, unknown>;
      expect(r.updateValidation).toBeUndefined();
      expect(r.findManyForValidation).toBeUndefined();
    });
  });

  describe('bulk delete', () => {
    it('deleteMany filters by id list', async () => {
      prisma.contact.deleteMany.mockResolvedValue({ count: 3 } as never);
      const r = await repo.deleteMany(['a', 'b', 'c']);
      expect(prisma.contact.deleteMany).toHaveBeenCalledWith({
        where: { id: { in: ['a', 'b', 'c'] } },
      });
      expect(r).toEqual({ count: 3 });
    });

    it('deleteAll uses empty filter', async () => {
      prisma.contact.deleteMany.mockResolvedValue({ count: 7 } as never);
      const r = await repo.deleteAll();
      expect(prisma.contact.deleteMany).toHaveBeenCalledWith({});
      expect(r).toEqual({ count: 7 });
    });
  });

  describe('related lookups', () => {
    it('findMessagesForContact orders by queuedAt desc and includes campaign', async () => {
      prisma.message.findMany.mockResolvedValue([] as never);
      await repo.findMessagesForContact('c1');
      expect(prisma.message.findMany).toHaveBeenCalledWith({
        where: { contactId: 'c1' },
        orderBy: { queuedAt: 'desc' },
        include: {
          campaign: { select: { id: true, name: true, templateId: true } },
        },
      });
    });

    it('findImportItemsForContact orders by id desc and includes batch metadata', async () => {
      prisma.importItem.findMany.mockResolvedValue([] as never);
      await repo.findImportItemsForContact('c1');
      expect(prisma.importItem.findMany).toHaveBeenCalledWith({
        where: { contactId: 'c1' },
        orderBy: { id: 'desc' },
        include: {
          importBatch: {
            select: { id: true, filename: true, createdAt: true },
          },
        },
      });
    });
  });

  describe('ContactsRepository.findIdsForSync', () => {
    // Fase B, review — o botão mostra o N de `unvalidatedContactWhere()`
    // (exclui quem já é inválido por `lastFailureReason` e quem tem entrega
    // provada), mas este `where` usava só `{ whatsappValid: null }`: o back
    // podia enfileirar MAIS que o N prometido, incluindo números já
    // conhecidos como inválidos — risco de bloqueio sem informação nova.
    it('usa unvalidatedContactWhere() para mode=unvalidated — o MESMO predicado do N do botão', async () => {
      const prisma = mockDeep<PrismaService>();
      const repo = new ContactsRepository(prisma);
      prisma.contact.findMany.mockResolvedValue([
        { id: 'c1' }, { id: 'c2' },
      ] as never);

      const ids = await repo.findIdsForSync('unvalidated', 100);

      expect(ids).toEqual(['c1', 'c2']);
      expect(prisma.contact.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: unvalidatedContactWhere() }),
      );
      expect(prisma.contact.findMany).toHaveBeenCalledWith({
        where: unvalidatedContactWhere(),
        select: { id: true },
        take: 100,
      });
    });

    // Hardening (achado 3) — `mode:'all'` era LITERALMENTE `{}`: a base
    // inteira, incluindo quem já é INVÁLIDO CONFIRMADO (mesmo risco que o
    // 'stale' já corrigia, e por um alcance MAIOR — 'all' nem exige
    // `whatsappCheckedAt` vencido). Rechecar quem o provedor já recusou é
    // puro risco de bloqueio, zero informação nova. O endpoint continua
    // aceitando mode:'all' (spec) — só o WHERE ganha o mesmo
    // `excludeInvalidWhere()` que 'stale' já usa.
    it('mode=all exclui quem já é inválido confirmado (excludeInvalidWhere) — não é mais a base inteira sem filtro', async () => {
      const prisma = mockDeep<PrismaService>();
      const repo = new ContactsRepository(prisma);
      prisma.contact.findMany.mockResolvedValue([{ id: 'c1' }] as never);

      await repo.findIdsForSync('all', 50);

      expect(prisma.contact.findMany).toHaveBeenCalledWith({
        where: excludeInvalidWhere(),
        select: { id: true },
        take: 50,
      });
    });

    // B.6, review (achado 2) — 'stale' é o job do CRON de RECHECAGEM: só quem
    // JÁ foi validado e está VENCIDO (>30d). O `{ whatsappCheckedAt: null }`
    // que existia aqui misturava esse job com o do operador ("Validar não
    // validados", mode='unvalidated') e ainda rechecava quem já é INVÁLIDO
    // CONFIRMADO — puro risco de banimento sem informação nova.
    it('mode=stale seleciona só `whatsappCheckedAt < cutoff` (nunca NULL) E exclui quem já é inválido confirmado', async () => {
      const prisma = mockDeep<PrismaService>();
      const repo = new ContactsRepository(prisma);
      prisma.contact.findMany.mockResolvedValue([] as never);
      const before = Date.now();

      await repo.findIdsForSync('stale', 5000);

      const call = prisma.contact.findMany.mock.calls[0][0] as {
        where: { AND: [{ whatsappCheckedAt: { lt: Date } }, unknown] };
        select: { id: true };
        take: number;
      };
      // AND de dois ramos: `lt: cutoff` (nunca um branch `null`) e o
      // complemento NULL-safe de `invalidContactWhere`.
      expect(call.where.AND).toHaveLength(2);
      const cutoff = call.where.AND[0].whatsappCheckedAt.lt;
      const expectedCutoffMs = before - 30 * 86400 * 1000;
      expect(cutoff.getTime()).toBeGreaterThanOrEqual(expectedCutoffMs - 1000);
      expect(cutoff.getTime()).toBeLessThanOrEqual(expectedCutoffMs + 1000);
      expect(call.where.AND[1]).toEqual(excludeInvalidWhere());
      expect(call.select).toEqual({ id: true });
      expect(call.take).toBe(5000);
    });
  });

  describe('facets', () => {
    it('aggregates active count, opted-out count, city/group groupings, and tag counts', async () => {
      prisma.contact.count
        .mockResolvedValueOnce(10) // totalActive
        .mockResolvedValueOnce(2); // totalOptedOut
      prisma.contact.groupBy
        .mockResolvedValueOnce([
          { city: 'Manaus', _count: { _all: 6 } },
          { city: 'São Paulo', _count: { _all: 3 } },
        ] as never)
        .mockResolvedValueOnce([
          { group: 'alunos', _count: { _all: 5 } },
          { group: 'parceiros', _count: { _all: 4 } },
        ] as never);
      prisma.contact.findMany.mockResolvedValue([
        { tags: ['vip', '2026'] },
        { tags: ['vip'] },
        { tags: [] },
        { tags: ['2026', 'novo'] },
      ] as never);

      const r = await repo.facets();

      expect(r.totalActive).toBe(10);
      expect(r.totalOptedOut).toBe(2);
      expect(r.cities).toEqual([
        { value: 'Manaus', count: 6 },
        { value: 'São Paulo', count: 3 },
      ]);
      expect(r.groups).toEqual([
        { value: 'alunos', count: 5 },
        { value: 'parceiros', count: 4 },
      ]);
      // Tags sorted by count desc, then value asc.
      expect(r.tags).toEqual([
        { value: '2026', count: 2 },
        { value: 'vip', count: 2 },
        { value: 'novo', count: 1 },
      ]);
    });

    it('drops null cities/groups defensively', async () => {
      prisma.contact.count.mockResolvedValueOnce(0).mockResolvedValueOnce(0);
      // Even though the query already filters `not: null`, the post-filter
      // exists to guard against driver quirks. Force it by injecting a null.
      prisma.contact.groupBy
        .mockResolvedValueOnce([
          { city: null, _count: { _all: 1 } },
          { city: 'Manaus', _count: { _all: 1 } },
        ] as never)
        .mockResolvedValueOnce([{ group: null, _count: { _all: 1 } }] as never);
      prisma.contact.findMany.mockResolvedValue([] as never);

      const r = await repo.facets();
      expect(r.cities).toEqual([{ value: 'Manaus', count: 1 }]);
      expect(r.groups).toEqual([]);
      expect(r.tags).toEqual([]);
    });
  });

  describe('buildContactListWhere — filtro de validade (B.3)', () => {
    it('sem filtro nenhum devolve {} (a lista inteira)', () => {
      expect(buildContactListWhere({ page: 1, pageSize: 50 })).toEqual({});
    });

    it('validity=invalid entra como AND, e não como chave solta', () => {
      expect(
        buildContactListWhere({ page: 1, pageSize: 50, validity: 'invalid' }),
      ).toEqual({ AND: [invalidContactWhere()] });
    });

    it('validity=unvalidated usa o predicado do helper, não um literal próprio', () => {
      expect(
        buildContactListWhere({ page: 1, pageSize: 50, validity: 'unvalidated' }),
      ).toEqual({ AND: [unvalidatedContactWhere()] });
    });

    /**
     * ★ COLISÃO DE CHAVE. Tanto "recebeu a campanha X" quanto "válido" falam de
     * `messages`. Se a validade entrasse como chave de primeiro nível, o spread
     * do objeto sobrescreveria uma das duas EM SILÊNCIO — a tela mostraria um
     * recorte e o operador acharia que era o outro. Por isso ela vai dentro de
     * `AND`.
     */
    it('validity + receivedCampaignId coexistem: nenhum `messages` sobrescreve o outro', () => {
      const where = buildContactListWhere({
        page: 1,
        pageSize: 50,
        validity: 'valid',
        receivedCampaignId: 'camp1',
      });
      expect(where.messages).toEqual({ some: reachedInCampaignFilter('camp1') });
      expect(where.AND).toEqual([validContactWhere()]);
    });
  });

  describe('listPaginated — validity chega ao Prisma', () => {
    it('passa o where do helper para findMany E para count', async () => {
      prisma.$transaction.mockResolvedValue([[], 0] as never);
      await repo.listPaginated({ page: 1, pageSize: 10, validity: 'invalid' });

      expect(prisma.contact.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { AND: [invalidContactWhere()] } }),
      );
      expect(prisma.contact.count).toHaveBeenCalledWith({
        where: { AND: [invalidContactWhere()] },
      });
    });
  });
});
