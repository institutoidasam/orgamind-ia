import { describe, it, expect, beforeEach } from 'vitest';
import { mockDeep } from 'vitest-mock-extended';
import { ContactSourceOrigin, MessageDirection } from '@prisma/client';
import { SourceOriginService } from './source-origin.service';
import { PrismaService } from '../../shared/prisma/prisma.service';

type FakeContact = {
  id: string;
  whatsappValid: boolean | null;
  sourceOrigin: ContactSourceOrigin | null;
  sourceOriginNote: string | null;
  sourceOriginAt: Date | null;
  lastInteractionAt: Date | null;
};

type FakeConversation = { contactId: string; lastInboundAt: Date | null };
type FakeMessage = { contactId: string; direction: MessageDirection; receivedAt: Date | null; createdAt: Date };
type FakeImportItem = { contactId: string; rawRow: unknown; importBatch: { filename: string } };

/**
 * Fake das quatro tabelas que o classificador lê. O que precisa ser exercido de
 * verdade aqui é o PIPELINE (paginação por cursor, coleta de sinais em lote,
 * escrita só do que mudou) — mockar `update` por chamada só provaria que
 * escrevemos o que escrevemos.
 */
function makeFakeDb(seed: {
  contacts: FakeContact[];
  conversations?: FakeConversation[];
  messages?: FakeMessage[];
  importItems?: FakeImportItem[];
}) {
  const contacts = new Map(seed.contacts.map((c) => [c.id, { ...c }]));
  const conversations = seed.conversations ?? [];
  const messages = seed.messages ?? [];
  const importItems = seed.importItems ?? [];
  const updates: Array<{ id: string; data: Record<string, unknown> }> = [];

  const prisma = mockDeep<PrismaService>();

  prisma.contact.findMany.mockImplementation((async (args: any) => {
    const after = args?.cursor?.id;
    const rows = [...contacts.values()].sort((a, b) => a.id.localeCompare(b.id));
    const start = after ? rows.findIndex((r) => r.id === after) + (args.skip ?? 0) : 0;
    return rows.slice(start, start + (args?.take ?? rows.length));
  }) as never);

  prisma.contact.update.mockImplementation((async ({ where, data }: any) => {
    const row = { ...contacts.get(where.id), ...data };
    contacts.set(where.id, row);
    updates.push({ id: where.id, data });
    return row;
  }) as never);

  prisma.conversation.groupBy.mockImplementation((async ({ where }: any) => {
    const ids: string[] = where.contactId.in;
    const byContact = new Map<string, Date | null>();
    for (const c of conversations) {
      if (!ids.includes(c.contactId)) continue;
      const prev = byContact.get(c.contactId) ?? null;
      if (c.lastInboundAt && (!prev || c.lastInboundAt > prev)) {
        byContact.set(c.contactId, c.lastInboundAt);
      } else if (!byContact.has(c.contactId)) byContact.set(c.contactId, prev);
    }
    return [...byContact].map(([contactId, lastInboundAt]) => ({
      contactId,
      _max: { lastInboundAt },
    }));
  }) as never);

  prisma.message.groupBy.mockImplementation((async ({ where }: any) => {
    const ids: string[] = where.contactId.in;
    const rows = messages.filter(
      (m) => ids.includes(m.contactId) && m.direction === where.direction,
    );
    const byContact = new Map<string, { receivedAt: Date | null; createdAt: Date }>();
    for (const m of rows) {
      const prev = byContact.get(m.contactId);
      byContact.set(m.contactId, {
        receivedAt:
          !prev?.receivedAt || (m.receivedAt && m.receivedAt > prev.receivedAt)
            ? (m.receivedAt ?? prev?.receivedAt ?? null)
            : prev.receivedAt,
        createdAt: !prev || m.createdAt > prev.createdAt ? m.createdAt : prev.createdAt,
      });
    }
    return [...byContact].map(([contactId, max]) => ({ contactId, _max: max }));
  }) as never);

  prisma.importItem.findMany.mockImplementation((async ({ where }: any) => {
    const ids: string[] = where.contactId.in;
    return importItems.filter((i) => ids.includes(i.contactId));
  }) as never);

  return { prisma, contacts, updates };
}

const CONTACT = (over: Partial<FakeContact> & { id: string }): FakeContact => ({
  whatsappValid: null,
  sourceOrigin: null,
  sourceOriginNote: null,
  sourceOriginAt: null,
  lastInteractionAt: null,
  ...over,
});

describe('SourceOriginService — classificação da base em coortes (spec §6.2)', () => {
  it('classifica cada coorte a partir dos sinais que já existem no banco', async () => {
    const db = makeFakeDb({
      contacts: [
        CONTACT({ id: 'c1-interagiu' }),
        CONTACT({ id: 'c2-declarou' }),
        CONTACT({ id: 'c3-sem-declaracao' }),
        CONTACT({ id: 'c4-desconhecido' }),
        CONTACT({ id: 'c5-invalido', whatsappValid: false }),
      ],
      conversations: [
        { contactId: 'c1-interagiu', lastInboundAt: new Date('2026-06-20T10:00:00Z') },
      ],
      importItems: [
        {
          contactId: 'c2-declarou',
          rawRow: { nome: 'Ana', consentimento: 'sim' },
          importBatch: { filename: 'feira_2025.xlsx' },
        },
        {
          contactId: 'c3-sem-declaracao',
          rawRow: { nome: 'Bia' },
          importBatch: { filename: 'lista_presenca.xlsx' },
        },
        // c5 tem lote COM declaração: ainda assim é C5 — a coorte inválida exclui.
        {
          contactId: 'c5-invalido',
          rawRow: { consentimento: 'sim' },
          importBatch: { filename: 'feira_2025.xlsx' },
        },
      ],
    });
    const service = new SourceOriginService(db.prisma);

    const report = await service.classifyAll();

    expect(db.contacts.get('c1-interagiu')?.sourceOrigin).toBe(ContactSourceOrigin.INTERAGIU);
    expect(db.contacts.get('c2-declarou')?.sourceOrigin).toBe(
      ContactSourceOrigin.DOCUMENTADA_COM_DECLARACAO,
    );
    expect(db.contacts.get('c3-sem-declaracao')?.sourceOrigin).toBe(
      ContactSourceOrigin.DOCUMENTADA_SEM_DECLARACAO,
    );
    expect(db.contacts.get('c4-desconhecido')?.sourceOrigin).toBe(
      ContactSourceOrigin.DESCONHECIDA,
    );
    expect(db.contacts.get('c5-invalido')?.sourceOrigin).toBe(
      ContactSourceOrigin.INVALIDO_NAO_WHATSAPP,
    );

    expect(report.scanned).toBe(5);
    expect(report.updated).toBe(5);
    expect(report.byOrigin).toMatchObject({
      INTERAGIU: 1,
      DOCUMENTADA_COM_DECLARACAO: 1,
      DOCUMENTADA_SEM_DECLARACAO: 1,
      DESCONHECIDA: 1,
      INVALIDO_NAO_WHATSAPP: 1,
    });
  });

  it('grava lastInteractionAt com o inbound MAIS RECENTE entre conversa e mensagem', async () => {
    const db = makeFakeDb({
      contacts: [CONTACT({ id: 'c1' })],
      conversations: [{ contactId: 'c1', lastInboundAt: new Date('2026-06-01T10:00:00Z') }],
      messages: [
        {
          contactId: 'c1',
          direction: MessageDirection.INBOUND,
          receivedAt: new Date('2026-06-25T10:00:00Z'),
          createdAt: new Date('2026-06-25T10:00:01Z'),
        },
      ],
    });
    const service = new SourceOriginService(db.prisma);

    await service.classifyAll();

    expect(db.contacts.get('c1')?.lastInteractionAt).toEqual(new Date('2026-06-25T10:00:00Z'));
  });

  it('uma Message INBOUND sozinha (sem Conversation) já é C1', async () => {
    const db = makeFakeDb({
      contacts: [CONTACT({ id: 'c1' })],
      messages: [
        {
          contactId: 'c1',
          direction: MessageDirection.INBOUND,
          receivedAt: null,
          createdAt: new Date('2026-05-05T10:00:00Z'),
        },
      ],
    });
    const service = new SourceOriginService(db.prisma);

    await service.classifyAll();

    expect(db.contacts.get('c1')?.sourceOrigin).toBe(ContactSourceOrigin.INTERAGIU);
    expect(db.contacts.get('c1')?.lastInteractionAt).toEqual(new Date('2026-05-05T10:00:00Z'));
  });

  it('mensagem OUTBOUND não é interação do titular — campanha que ele ignorou não vira C1', async () => {
    const db = makeFakeDb({
      contacts: [CONTACT({ id: 'c1' })],
      messages: [
        {
          contactId: 'c1',
          direction: MessageDirection.OUTBOUND,
          receivedAt: null,
          createdAt: new Date('2026-05-05T10:00:00Z'),
        },
      ],
    });
    const service = new SourceOriginService(db.prisma);

    await service.classifyAll();

    expect(db.contacts.get('c1')?.sourceOrigin).toBe(ContactSourceOrigin.DESCONHECIDA);
    expect(db.contacts.get('c1')?.lastInteractionAt).toBeNull();
  });

  describe('idempotência (re-executável)', () => {
    it('rodar de novo não muda nada e não reescreve linha nenhuma', async () => {
      const db = makeFakeDb({
        contacts: [CONTACT({ id: 'c1' }), CONTACT({ id: 'c2', whatsappValid: false })],
        conversations: [{ contactId: 'c1', lastInboundAt: new Date('2026-06-20T10:00:00Z') }],
      });
      const service = new SourceOriginService(db.prisma);

      const first = await service.classifyAll();
      const before = new Map([...db.contacts].map(([k, v]) => [k, { ...v }]));
      db.updates.length = 0;

      const second = await service.classifyAll();

      expect(first.updated).toBe(2);
      expect(second.scanned).toBe(2);
      // O ponto: a 2ª passada NÃO emite UPDATE. Numa base de 13k isso é a
      // diferença entre um job de auditoria e uma reescrita completa da tabela
      // (que ainda por cima mexeria em `updatedAt` de todo mundo).
      expect(second.updated).toBe(0);
      expect(second.unchanged).toBe(2);
      expect(db.updates).toHaveLength(0);
      expect([...db.contacts]).toEqual([...before]);
    });

    it('reclassifica quando o sinal MUDA (o contato respondeu depois da 1ª passada)', async () => {
      const conversations: FakeConversation[] = [];
      const db = makeFakeDb({ contacts: [CONTACT({ id: 'c1' })], conversations });
      const service = new SourceOriginService(db.prisma);

      await service.classifyAll();
      expect(db.contacts.get('c1')?.sourceOrigin).toBe(ContactSourceOrigin.DESCONHECIDA);

      conversations.push({ contactId: 'c1', lastInboundAt: new Date('2026-07-01T10:00:00Z') });
      const second = await service.classifyAll();

      expect(second.updated).toBe(1);
      expect(db.contacts.get('c1')?.sourceOrigin).toBe(ContactSourceOrigin.INTERAGIU);
    });
  });

  it('pagina a base por cursor (13k contatos não cabem numa consulta só)', async () => {
    const db = makeFakeDb({
      contacts: Array.from({ length: 5 }, (_, i) => CONTACT({ id: `c${i}` })),
    });
    const service = new SourceOriginService(db.prisma);

    const report = await service.classifyAll({ batchSize: 2 });

    expect(report.scanned).toBe(5);
    // 5 contatos / lote de 2 = páginas de 2, 2 e 1. A última vem incompleta e
    // encerra o laço ali mesmo — sem a consulta vazia extra que um `while(true)`
    // ingênuo faria.
    expect(db.prisma.contact.findMany).toHaveBeenCalledTimes(3);
  });
});
