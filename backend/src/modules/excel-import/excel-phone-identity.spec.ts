import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as ExcelJS from 'exceljs';
import { ExcelService } from './excel.service';
import type { PrismaService } from '../../shared/prisma/prisma.service';
import type { AuditService } from '../../shared/audit/audit.service';
import type { Queue } from 'bullmq';
import type { ConsentService } from '../consent/consent.service';

/**
 * C6 / C15 — A PLANILHA É A PORTA DE ENTRADA DA BASE, e era por ela que a mesma
 * pessoa virava duas.
 *
 * `+5592995550101` (13 díg.) e `+559295550101` (12 díg.) são a MESMA conta de
 * WhatsApp — o GoZap resolve o número canônico no envio, então as duas linhas
 * convergem no MESMO destino e a pessoa recebe a campanha DUAS VEZES de verdade.
 * O import casava por igualdade EXATA da string nos dois lados: contra o banco
 * (o `findMany` em massa) e dentro do próprio arquivo (o Set `seen`).
 */
describe('C6 — identidade do contato por variante do 9º dígito', () => {
  let service: ExcelService;
  let prisma: { $transaction: ReturnType<typeof vi.fn> };
  let audit: AuditService;
  let syncQueue: { add: ReturnType<typeof vi.fn> };
  let consent: {
    suppressedPhones: ReturnType<typeof vi.fn>;
    rehydrate: ReturnType<typeof vi.fn>;
    findActivePurpose: ReturnType<typeof vi.fn>;
    record: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    prisma = { $transaction: vi.fn() };
    audit = {
      log: vi.fn().mockResolvedValue(undefined),
    } as unknown as AuditService;
    syncQueue = { add: vi.fn().mockResolvedValue(undefined) };
    consent = {
      suppressedPhones: vi.fn().mockResolvedValue(new Set<string>()),
      rehydrate: vi.fn().mockResolvedValue([]),
      findActivePurpose: vi.fn().mockResolvedValue(null),
      record: vi.fn().mockResolvedValue({ eventId: 'ev', created: true }),
    };
    service = new ExcelService(
      prisma as unknown as PrismaService,
      audit,
      syncQueue as unknown as Queue,
      consent as unknown as ConsentService,
    );
  });

  /** Planilha com uma coluna `telefone` e as linhas dadas. */
  async function sheet(phones: string[]): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Contacts');
    ws.addRow(['telefone', 'nome']);
    phones.forEach((p, i) => ws.addRow([p, `Pessoa ${i}`]));
    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  /**
   * Um `tx` que se comporta como o BANCO DE VERDADE: o `findMany` respeita o
   * `where` recebido, em vez de devolver uma lista fixa. Mockar o retorno
   * testaria o mock; o que está em julgamento aqui é justamente o `where` que o
   * serviço monta — e o `where` do `update`, que estoura P2025 quando a grafia
   * gravada difere da grafia da planilha.
   */
  function txOverDb(seedRows: Array<{ id: string; phoneE164: string }>) {
    const rows = [...seedRows];
    const contactUpdates: Array<{ where: any; data: any }> = [];
    const contactCreateMany: any[][] = [];
    const findManyArgs: any[] = [];
    let nextId = 0;
    const impl = async (callback: any) => {
      const tx = {
        importBatch: {
          create: vi.fn().mockResolvedValue({ id: 'batch-1' }),
          update: vi.fn().mockResolvedValue({ id: 'batch-1' }),
        },
        contact: {
          findMany: vi.fn().mockImplementation(async (args: any) => {
            findManyArgs.push(args);
            const wanted: string[] = args.where.phoneE164.in;
            return rows
              .filter((r) => wanted.includes(r.phoneE164))
              .map((r) => ({ id: r.id, phoneE164: r.phoneE164 }));
          }),
          createMany: vi.fn().mockImplementation(async (args: any) => {
            contactCreateMany.push(args.data);
            for (const d of args.data) {
              if (!rows.some((r) => r.phoneE164 === d.phoneE164)) {
                rows.push({ id: `novo-${nextId++}`, phoneE164: d.phoneE164 });
              }
            }
            return { count: args.data.length };
          }),
          update: vi.fn().mockImplementation(async (args: any) => {
            contactUpdates.push(args);
            const row =
              rows.find((r) => r.id === args.where?.id) ??
              rows.find((r) => r.phoneE164 === args.where?.phoneE164);
            if (!row) {
              // É EXATAMENTE o P2025 que o `where: { phoneE164 }` provocaria
              // quando a base guarda a OUTRA grafia da mesma pessoa.
              throw new Error('P2025: nenhum Contact casa com este where');
            }
            return { id: row.id };
          }),
        },
        importItem: { createMany: vi.fn().mockResolvedValue({ count: 0 }) },
      };
      return callback(tx);
    };
    return { impl, contactUpdates, contactCreateMany, findManyArgs, rows };
  }

  it('CASO A — a planilha traz a outra grafia de um contato existente: ATUALIZA, não cria', async () => {
    const tx = txOverDb([{ id: 'c-existente', phoneE164: '+5592995550101' }]);
    prisma.$transaction.mockImplementation(tx.impl);

    const result = await service.importBuffer(
      'base.xlsx',
      await sheet(['(92) 9555-0101']),
      { batchId: 'batch-1' },
    );

    expect(result).toMatchObject({ created: 0, updated: 1 });
    expect(tx.contactCreateMany).toEqual([]);
  });

  it('CASO A — a busca em massa consulta as DUAS grafias (o where, não o retorno)', async () => {
    const tx = txOverDb([{ id: 'c-existente', phoneE164: '+5592995550101' }]);
    prisma.$transaction.mockImplementation(tx.impl);

    await service.importBuffer('base.xlsx', await sheet(['(92) 9555-0101']), {
      batchId: 'batch-1',
    });

    expect(tx.findManyArgs[0].where.phoneE164.in).toEqual(
      expect.arrayContaining(['+559295550101', '+5592995550101']),
    );
  });

  it('CASO A — o UPDATE vai por `id`, e a grafia canônica gravada não é reescrita', async () => {
    const tx = txOverDb([{ id: 'c-existente', phoneE164: '+5592995550101' }]);
    prisma.$transaction.mockImplementation(tx.impl);

    await service.importBuffer('base.xlsx', await sheet(['(92) 9555-0101']), {
      batchId: 'batch-1',
    });

    expect(tx.contactUpdates[0].where).toEqual({ id: 'c-existente' });
    expect(tx.contactUpdates[0].data.phoneE164).toBeUndefined();
  });

  it('CASO A — a reidratação de consentimento NÃO roda: nenhum contato nasceu', async () => {
    const tx = txOverDb([{ id: 'c-existente', phoneE164: '+5592995550101' }]);
    prisma.$transaction.mockImplementation(tx.impl);

    await service.importBuffer('base.xlsx', await sheet(['(92) 9555-0101']), {
      batchId: 'batch-1',
    });

    // C7: era a reidratação cruzada que fazia o gêmeo nascer GRANTED e passar o
    // gate. Sem gêmeo, ela não tem em quem rodar.
    expect(consent.rehydrate).not.toHaveBeenCalled();
  });

  it('CASO B — as duas grafias da mesma pessoa NO MESMO ARQUIVO contam como duplicata', async () => {
    const tx = txOverDb([]);
    prisma.$transaction.mockImplementation(tx.impl);

    const result = await service.importBuffer(
      'base.xlsx',
      await sheet(['(92) 99555-0101', '(92) 9555-0101']),
      { batchId: 'batch-1' },
    );

    expect(result).toMatchObject({ total: 2, created: 1, duplicates: 1 });
    expect(tx.contactCreateMany[0]).toHaveLength(1);
  });

  it('CASO B — a ordem das linhas não muda o resultado (12 díg. primeiro)', async () => {
    const tx = txOverDb([]);
    prisma.$transaction.mockImplementation(tx.impl);

    const result = await service.importBuffer(
      'base.xlsx',
      await sheet(['(92) 9555-0101', '(92) 99555-0101']),
      { batchId: 'batch-1' },
    );

    expect(result).toMatchObject({ created: 1, duplicates: 1 });
  });

  it('não confunde pessoas DIFERENTES: um FIXO não vira variante de um celular', async () => {
    // +559232145678 é fixo (miolo começa com 3). Prefixar um 9 inventaria
    // +5592932145678, que é de outra pessoa — fundir os dois seria pior que o
    // bug original.
    const tx = txOverDb([{ id: 'c-fixo', phoneE164: '+5592932145678' }]);
    prisma.$transaction.mockImplementation(tx.impl);

    const result = await service.importBuffer(
      'base.xlsx',
      await sheet(['(92) 3214-5678']),
      { batchId: 'batch-1' },
    );

    expect(result).toMatchObject({ created: 1, updated: 0 });
  });

  it('duas pessoas diferentes continuam duas: nenhuma fusão indevida', async () => {
    const tx = txOverDb([]);
    prisma.$transaction.mockImplementation(tx.impl);

    const result = await service.importBuffer(
      'base.xlsx',
      await sheet(['(92) 99555-0101', '(92) 99555-0102']),
      { batchId: 'batch-1' },
    );

    expect(result).toMatchObject({ created: 2, duplicates: 0 });
  });
});
