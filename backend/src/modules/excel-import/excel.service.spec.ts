import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as ExcelJS from 'exceljs';
import { ConsentAction, ConsentSource } from '@prisma/client';
import { ExcelService, MAX_IMPORT_ROWS, cellToString } from './excel.service';
import { EmptyWorkbookError } from './errors/excel.errors';
import type { PrismaService } from '../../shared/prisma/prisma.service';
import type { AuditService } from '../../shared/audit/audit.service';
import type { Queue } from 'bullmq';
import type { ConsentService } from '../consent/consent.service';

/**
 * Build a minimal xlsx buffer with a header row and N data rows.
 * Each row's name field is suffixed with the index so callers can target
 * a particular call (e.g. "throw on the 3rd upsert").
 */
async function makeWorkbook(rowCount: number): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Contacts');
  ws.addRow(['telefone', 'nome', 'cidade']);
  // Use distinct local-format Brazilian mobile numbers so libphonenumber-js
  // accepts them all. Pattern: (92) 9XXXX-YYYY where XXXX/YYYY varies.
  for (let i = 0; i < rowCount; i++) {
    const last4 = String(1000 + i).padStart(4, '0');
    ws.addRow([`(92) 99876-${last4}`, `Person ${i}`, 'Manaus']);
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/**
 * A $transaction mock that records every upsert call so tests can assert on
 * the create/update payloads. `existing` lets the test pre-seed phones that
 * should be treated as updates (contact.findMany returns them).
 */
function makeTxMock(opts?: {
  existing?: Array<{ id: string; phoneE164: string }>;
}) {
  const upsertCalls: Array<{ where: any; create: any; update: any }> = [];
  const createManyCalls: any[][] = [];
  const updateManyCalls: any[] = [];
  const contactCreateMany: any[][] = [];
  const impl = async (callback: any) => {
    let n = 0;
    const tx = {
      importBatch: {
        create: vi.fn().mockResolvedValue({ id: 'batch-1' }),
        update: vi.fn().mockResolvedValue({}),
      },
      contact: {
        findMany: vi.fn().mockResolvedValue(opts?.existing ?? []),
        upsert: vi.fn().mockImplementation(async (args: any) => {
          upsertCalls.push(args);
          return { id: `contact-${n++}`, phoneE164: args.where.phoneE164 };
        }),
        createMany: vi.fn().mockImplementation(async (args: any) => {
          contactCreateMany.push(args.data);
          return { count: args.data.length };
        }),
        // C6 — o update do import agora vai por `id`: a grafia gravada pode
        // diferir da grafia da planilha (as duas formas do 9º dígito).
        update: vi.fn().mockImplementation(async (args: any) => {
          updateManyCalls.push(args);
          return { id: args.where.id ?? 'updated' };
        }),
        updateMany: vi.fn().mockImplementation(async (args: any) => {
          updateManyCalls.push(args);
          return { count: 1 };
        }),
      },
      importItem: { createMany: vi.fn().mockResolvedValue({ count: 0 }) },
    };
    return callback(tx);
  };
  return {
    impl,
    upsertCalls,
    createManyCalls,
    updateManyCalls,
    contactCreateMany,
  };
}

describe('A7 — cell coercion (object-typed cells)', () => {
  let service: ExcelService;
  let prisma: { $transaction: ReturnType<typeof vi.fn> };
  let audit: AuditService;
  let syncQueue: { add: ReturnType<typeof vi.fn> };
  let consent: {
    suppressedPhones: ReturnType<typeof vi.fn>;
    rehydrate: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    prisma = { $transaction: vi.fn() };
    audit = {
      log: vi.fn().mockResolvedValue(undefined),
    } as unknown as AuditService;
    syncQueue = { add: vi.fn().mockResolvedValue(undefined) };
    // Ninguém suprimido por padrão — os testes de supressão sobrescrevem.
    consent = {
      suppressedPhones: vi.fn().mockResolvedValue(new Set<string>()),
      rehydrate: vi.fn().mockResolvedValue([]),
    };
    service = new ExcelService(
      prisma as unknown as PrismaService,
      audit,
      syncQueue as unknown as Queue,
      consent as unknown as ConsentService,
    );
  });

  it('reads a phone stored as a hyperlink cell (uses .text, not [object Object])', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Contacts');
    ws.addRow(['telefone', 'nome']);
    const row = ws.addRow([null, 'Hyper Person']);
    row.getCell(1).value = {
      text: '(92) 99876-1234',
      hyperlink: 'tel:+5592998761234',
    };
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());

    const tx = makeTxMock();
    prisma.$transaction.mockImplementation(tx.impl);

    const result = await service.importBuffer('hyper.xlsx', buffer);
    // Hyperlink phone must normalize to a valid contact, not INVALID.
    expect(result).toMatchObject({ created: 1, invalid: 0 });
  });

  it('reads a phone stored as a formula cell (uses .result recursively)', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Contacts');
    ws.addRow(['telefone', 'nome']);
    const row = ws.addRow([null, 'Formula Person']);
    row.getCell(1).value = {
      formula: 'CONCAT("(92) ","99876-2345")',
      result: '(92) 99876-2345',
    };
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());

    const tx = makeTxMock();
    prisma.$transaction.mockImplementation(tx.impl);

    const result = await service.importBuffer('formula.xlsx', buffer);
    expect(result).toMatchObject({ created: 1, invalid: 0 });
  });

  it('reads a rich-text name as plain text (not "[object Object]")', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Contacts');
    ws.addRow(['telefone', 'nome']);
    const row = ws.addRow(['(92) 99876-3456', null]);
    row.getCell(2).value = {
      richText: [
        { text: 'Maria ' },
        { text: 'da Silva', font: { bold: true } },
      ],
    };
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());

    const tx = makeTxMock();
    prisma.$transaction.mockImplementation(tx.impl);

    await service.importBuffer('rich.xlsx', buffer);

    const savedName = tx.contactCreateMany[0]?.[0]?.name;
    expect(savedName).toBe('Maria da Silva');
  });
});

describe('ExcelService', () => {
  let service: ExcelService;
  let prisma: {
    $transaction: ReturnType<typeof vi.fn>;
  };
  let audit: AuditService;
  let syncQueue: { add: ReturnType<typeof vi.fn> };
  let consent: {
    suppressedPhones: ReturnType<typeof vi.fn>;
    rehydrate: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    prisma = { $transaction: vi.fn() };
    audit = {
      log: vi.fn().mockResolvedValue(undefined),
    } as unknown as AuditService;
    syncQueue = { add: vi.fn().mockResolvedValue(undefined) };
    // Ninguém suprimido por padrão — os testes de supressão sobrescrevem.
    consent = {
      suppressedPhones: vi.fn().mockResolvedValue(new Set<string>()),
      rehydrate: vi.fn().mockResolvedValue([]),
    };
    service = new ExcelService(
      prisma as unknown as PrismaService,
      audit,
      syncQueue as unknown as Queue,
      consent as unknown as ConsentService,
    );
  });

  describe('importBuffer rollback semantics', () => {
    it('propagates the underlying error when a contact write fails mid-batch', async () => {
      const buffer = await makeWorkbook(5);

      // Simulate Prisma transaction semantics: when the callback throws,
      // $transaction rejects with the same error and no work is committed.
      // New contacts are now inserted via createMany; a constraint violation
      // surfaces there and must propagate out of the transaction.
      prisma.$transaction.mockImplementation(async (callback: any) => {
        const tx = {
          importBatch: {
            create: vi.fn().mockResolvedValue({ id: 'batch-1' }),
            update: vi.fn().mockResolvedValue({}),
          },
          contact: {
            findMany: vi.fn().mockResolvedValue([]),
            createMany: vi.fn().mockImplementation(async () => {
              // Mid-batch failure (e.g. constraint violation).
              throw new Error('P2002: unique constraint failed');
            }),
            update: vi.fn().mockResolvedValue({ id: 'x' }),
          },
          importItem: { createMany: vi.fn().mockResolvedValue({ count: 0 }) },
        };

        try {
          return await callback(tx);
        } catch (err) {
          // Simulate Prisma's actual behaviour: the transaction rejects and
          // any prior writes are rolled back. The test asserts via the
          // promise rejection below + importItem.createMany not being called
          // (we never reach that point in the code path).
          (tx as any)._rolledBack = true;
          expect(tx.importItem.createMany).not.toHaveBeenCalled();
          throw err;
        }
      });

      await expect(
        service.importBuffer('contacts.xlsx', buffer),
      ).rejects.toThrow(/unique constraint failed/);

      // The transaction body should have been invoked (and aborted), not
      // bypassed. Confirms the rollback path went through $transaction.
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    });

    it('throws EmptyWorkbookError when the workbook has no worksheets', async () => {
      const wb = new ExcelJS.Workbook();
      const buffer = Buffer.from(await wb.xlsx.writeBuffer());

      await expect(
        service.importBuffer('empty.xlsx', buffer),
      ).rejects.toBeInstanceOf(EmptyWorkbookError);
      // Empty-workbook guard runs before $transaction is opened.
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('runs the entire batch in a single transaction (atomicity contract)', async () => {
      const buffer = await makeWorkbook(4);

      prisma.$transaction.mockImplementation(async (callback: any) => {
        let findCall = 0;
        const tx = {
          importBatch: {
            create: vi.fn().mockResolvedValue({ id: 'batch-1' }),
            update: vi.fn().mockResolvedValue({}),
          },
          contact: {
            // 1st findMany = pre-fetch existing (none); 2nd = inserted ids.
            findMany: vi.fn().mockImplementation(async (args: any) => {
              findCall++;
              if (findCall === 1) return [];
              const phones: string[] = args.where.phoneE164.in;
              return phones.map((p, i) => ({
                id: `contact-${i}`,
                phoneE164: p,
              }));
            }),
            createMany: vi
              .fn()
              .mockImplementation(async (args: any) => ({
                count: args.data.length,
              })),
            update: vi.fn().mockResolvedValue({ id: 'x' }),
          },
          importItem: { createMany: vi.fn().mockResolvedValue({ count: 4 }) },
        };
        return callback(tx);
      });

      const result = await service.importBuffer('contacts.xlsx', buffer);
      expect(result).toMatchObject({ total: 4, created: 4, updated: 0 });
      // Single transaction wraps the whole batch.
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    });
  });

  describe('sync enqueue after import', () => {
    it('enqueues 1 sync job per chunk of 50 imported contacts (triggeredBy=import)', async () => {
      const totalContacts = 120;
      const buffer = await makeWorkbook(totalContacts);

      // Build deterministic ids: c0..c119, keyed to sheet (and createMany) order.
      const allIds = Array.from({ length: totalContacts }, (_, i) => `c${i}`);

      prisma.$transaction.mockImplementation(async (callback: any) => {
        let findCall = 0;
        // O que o createMany DE FATO inseriu — o re-fetch só pode devolver isso.
        // (O mock antigo fabricava uma linha para cada telefone CONSULTADO; com
        // a busca por variantes do 9º dígito, isso inventaria o dobro de
        // contatos, nenhum deles existente.)
        const insertedRows: Array<{ id: string; phoneE164: string }> = [];
        const tx = {
          importBatch: {
            create: vi.fn().mockResolvedValue({ id: 'batch-1' }),
            update: vi.fn().mockResolvedValue({}),
          },
          contact: {
            // 1st findMany = pre-fetch existing (none); 2nd = inserted ids, in
            // createMany order (== sheet order).
            findMany: vi.fn().mockImplementation(async (args: any) => {
              findCall++;
              if (findCall === 1) return [];
              const wanted: string[] = args.where.phoneE164.in;
              return insertedRows.filter((r) => wanted.includes(r.phoneE164));
            }),
            createMany: vi
              .fn()
              .mockImplementation(async (args: any) => {
                for (const d of args.data) {
                  insertedRows.push({
                    id: allIds[insertedRows.length],
                    phoneE164: d.phoneE164,
                  });
                }
                return { count: args.data.length };
              }),
            update: vi.fn().mockResolvedValue({ id: 'x' }),
          },
          importItem: {
            createMany: vi.fn().mockResolvedValue({ count: totalContacts }),
          },
        };
        return callback(tx);
      });

      const result = await service.importBuffer('big.xlsx', buffer);
      expect(result).toMatchObject({
        total: totalContacts,
        created: totalContacts,
        updated: 0,
      });

      // Fire-and-forget: wait one tick for the .catch chain to settle
      await new Promise((r) => setImmediate(r));

      // 120 ids → 3 chunks: [0..49], [50..99], [100..119]
      expect(syncQueue.add).toHaveBeenCalledTimes(3);

      const [name1, payload1] = syncQueue.add.mock.calls[0] as [
        string,
        { contactIds: string[]; triggeredBy: string },
      ];
      expect(name1).toBe('sync');
      expect(payload1.triggeredBy).toBe('import');
      expect(payload1.contactIds).toEqual(allIds.slice(0, 50));

      const [, payload3] = syncQueue.add.mock.calls[2] as [
        string,
        { contactIds: string[]; triggeredBy: string },
      ];
      expect(payload3.contactIds).toEqual(allIds.slice(100, 120));
    });
  });
});

describe('A8 — bounds (row cap + batched upserts)', () => {
  let service: ExcelService;
  let prisma: { $transaction: ReturnType<typeof vi.fn> };
  let audit: AuditService;
  let syncQueue: { add: ReturnType<typeof vi.fn> };
  let consent: {
    suppressedPhones: ReturnType<typeof vi.fn>;
    rehydrate: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    prisma = { $transaction: vi.fn() };
    audit = {
      log: vi.fn().mockResolvedValue(undefined),
    } as unknown as AuditService;
    syncQueue = { add: vi.fn().mockResolvedValue(undefined) };
    // Ninguém suprimido por padrão — os testes de supressão sobrescrevem.
    consent = {
      suppressedPhones: vi.fn().mockResolvedValue(new Set<string>()),
      rehydrate: vi.fn().mockResolvedValue([]),
    };
    service = new ExcelService(
      prisma as unknown as PrismaService,
      audit,
      syncQueue as unknown as Queue,
      consent as unknown as ConsentService,
    );
  });

  it('rejects with a 422 ValidationError BEFORE opening the transaction when rows exceed MAX_IMPORT_ROWS', async () => {
    // MAX_IMPORT_ROWS is 50_000; build one row over the cap. Building a real
    // 50k-row workbook is ~2.6s, so give it a generous timeout (the default 5s
    // flakes when the suite runs under load).
    const buffer = await makeWorkbook(MAX_IMPORT_ROWS + 1);

    await expect(
      service.importBuffer('huge.xlsx', buffer),
    ).rejects.toMatchObject({ status: 422 });
    // Guard runs before the transaction is opened.
    expect(prisma.$transaction).not.toHaveBeenCalled();
  }, 30_000);

  it('accepts a workbook under the cap', async () => {
    const buffer = await makeWorkbook(3);
    const tx = makeTxMock();
    prisma.$transaction.mockImplementation(tx.impl);
    const result = await service.importBuffer('ok.xlsx', buffer);
    expect(result).toMatchObject({ total: 3, created: 3 });
  });

  it('does NOT do one sequential upsert per row (batches new contacts via createMany)', async () => {
    // All rows are new (findMany returns []). Expectation: the import must not
    // issue N individual contact.upsert calls inside the transaction; new
    // contacts go through createMany batching.
    const buffer = await makeWorkbook(10);
    const tx = makeTxMock();
    prisma.$transaction.mockImplementation(tx.impl);

    const result = await service.importBuffer('batch.xlsx', buffer);
    expect(result).toMatchObject({ total: 10, created: 10 });

    // No per-row upsert; new contacts inserted in bulk.
    expect(tx.upsertCalls.length).toBe(0);
    const totalCreated = tx.contactCreateMany.reduce(
      (sum, batch) => sum + batch.length,
      0,
    );
    expect(totalCreated).toBe(10);
  });
});

describe('Baixo — re-import tag preservation', () => {
  let service: ExcelService;
  let prisma: { $transaction: ReturnType<typeof vi.fn> };
  let audit: AuditService;
  let syncQueue: { add: ReturnType<typeof vi.fn> };
  let consent: {
    suppressedPhones: ReturnType<typeof vi.fn>;
    rehydrate: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    prisma = { $transaction: vi.fn() };
    audit = {
      log: vi.fn().mockResolvedValue(undefined),
    } as unknown as AuditService;
    syncQueue = { add: vi.fn().mockResolvedValue(undefined) };
    // Ninguém suprimido por padrão — os testes de supressão sobrescrevem.
    consent = {
      suppressedPhones: vi.fn().mockResolvedValue(new Set<string>()),
      rehydrate: vi.fn().mockResolvedValue([]),
    };
    service = new ExcelService(
      prisma as unknown as PrismaService,
      audit,
      syncQueue as unknown as Queue,
      consent as unknown as ConsentService,
    );
  });

  it('does NOT overwrite tags on update when the sheet has no tags column', async () => {
    // Sheet without a `tags` column. Re-importing an existing contact must not
    // clobber their existing tags with [].
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Contacts');
    ws.addRow(['telefone', 'nome']);
    ws.addRow(['(92) 99876-1234', 'Existing Person']);
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());

    const tx = makeTxMock({
      existing: [{ id: 'c-existing', phoneE164: '+5592998761234' }],
    });
    prisma.$transaction.mockImplementation(tx.impl);

    const result = await service.importBuffer('notags.xlsx', buffer);
    expect(result).toMatchObject({ updated: 1 });

    // Find the update payload (could be update or updateMany shape).
    const updatePayload = tx.updateManyCalls[0];
    const data = updatePayload?.data ?? updatePayload;
    expect(data?.tags).toBeUndefined();
  });

  it('DOES set tags on update when the sheet has a tags column', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Contacts');
    ws.addRow(['telefone', 'nome', 'tags']);
    ws.addRow(['(92) 99876-1234', 'Existing Person', 'vip, novo']);
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());

    const tx = makeTxMock({
      existing: [{ id: 'c-existing', phoneE164: '+5592998761234' }],
    });
    prisma.$transaction.mockImplementation(tx.impl);

    const result = await service.importBuffer('withtags.xlsx', buffer);
    expect(result).toMatchObject({ updated: 1 });

    const updatePayload = tx.updateManyCalls[0];
    const data = updatePayload?.data ?? updatePayload;
    expect(data?.tags).toEqual(['vip', 'novo']);
  });
});

describe('Baixo — duplicate / empty header detection', () => {
  let service: ExcelService;
  let prisma: { $transaction: ReturnType<typeof vi.fn> };
  let audit: AuditService;
  let syncQueue: { add: ReturnType<typeof vi.fn> };
  let consent: {
    suppressedPhones: ReturnType<typeof vi.fn>;
    rehydrate: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    prisma = { $transaction: vi.fn() };
    audit = {
      log: vi.fn().mockResolvedValue(undefined),
    } as unknown as AuditService;
    syncQueue = { add: vi.fn().mockResolvedValue(undefined) };
    // Ninguém suprimido por padrão — os testes de supressão sobrescrevem.
    consent = {
      suppressedPhones: vi.fn().mockResolvedValue(new Set<string>()),
      rehydrate: vi.fn().mockResolvedValue([]),
    };
    service = new ExcelService(
      prisma as unknown as PrismaService,
      audit,
      syncQueue as unknown as Queue,
      consent as unknown as ConsentService,
    );
  });

  it('rejects when two columns normalize to the same header (silent merge)', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Contacts');
    // "Nome" and "nome " normalize to the same key.
    ws.addRow(['telefone', 'Nome', 'nome ']);
    ws.addRow(['(92) 99876-1234', 'A', 'B']);
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());

    await expect(
      service.importBuffer('dupheader.xlsx', buffer),
    ).rejects.toMatchObject({ code: 'excel.duplicate_header' });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe('cellToString — primitive and object coercion paths', () => {
  it('returns "" for null and undefined', () => {
    expect(cellToString(null)).toBe('');
    expect(cellToString(undefined)).toBe('');
  });

  it('passes strings through unchanged', () => {
    expect(cellToString('hello')).toBe('hello');
  });

  it('stringifies numbers and booleans', () => {
    expect(cellToString(42)).toBe('42');
    expect(cellToString(0)).toBe('0');
    expect(cellToString(true)).toBe('true');
    expect(cellToString(false)).toBe('false');
  });

  it('stringifies bigint', () => {
    expect(cellToString(123n)).toBe('123');
  });

  it('renders Date as ISO date (no time)', () => {
    expect(cellToString(new Date('2026-06-15T12:34:56.000Z'))).toBe(
      '2026-06-15',
    );
  });

  it('unwraps hyperlink cells via .text', () => {
    expect(cellToString({ text: '(92) 1', hyperlink: 'tel:1' })).toBe('(92) 1');
  });

  it('recurses into non-string .text values', () => {
    expect(cellToString({ text: 99 })).toBe('99');
  });

  it('joins rich-text runs', () => {
    expect(
      cellToString({ richText: [{ text: 'Maria ' }, { text: 'Silva' }] }),
    ).toBe('Maria Silva');
  });

  it('unwraps formula cells via .result (recursively)', () => {
    expect(cellToString({ formula: 'A1', result: 'computed' })).toBe(
      'computed',
    );
    expect(cellToString({ formula: 'A1', result: { error: '#DIV/0!' } })).toBe(
      '#DIV/0!',
    );
  });

  it('surfaces Excel error codes', () => {
    expect(cellToString({ error: '#REF!' })).toBe('#REF!');
  });

  it('returns "" for an unrecognized object shape', () => {
    expect(cellToString({ foo: 'bar' })).toBe('');
  });
});

describe('field precedence + customFields extraction (classifier)', () => {
  let service: ExcelService;
  let prisma: { $transaction: ReturnType<typeof vi.fn> };
  let audit: AuditService;
  let syncQueue: { add: ReturnType<typeof vi.fn> };
  let consent: {
    suppressedPhones: ReturnType<typeof vi.fn>;
    rehydrate: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    prisma = { $transaction: vi.fn() };
    audit = {
      log: vi.fn().mockResolvedValue(undefined),
    } as unknown as AuditService;
    syncQueue = { add: vi.fn().mockResolvedValue(undefined) };
    // Ninguém suprimido por padrão — os testes de supressão sobrescrevem.
    consent = {
      suppressedPhones: vi.fn().mockResolvedValue(new Set<string>()),
      rehydrate: vi.fn().mockResolvedValue([]),
    };
    service = new ExcelService(
      prisma as unknown as PrismaService,
      audit,
      syncQueue as unknown as Queue,
      consent as unknown as ConsentService,
    );
  });

  it('prefers PT-BR keys over EN keys (telefone/nome/cidade/grupo win)', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Contacts');
    ws.addRow(['telefone', 'phone', 'nome', 'name', 'cidade', 'city', 'grupo', 'group']);
    ws.addRow([
      '(92) 99876-1234',
      '(92) 90000-0000',
      'NomeWins',
      'NameLoses',
      'CidadeWins',
      'CityLoses',
      'GrupoWins',
      'GroupLoses',
    ]);
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());

    const tx = makeTxMock();
    prisma.$transaction.mockImplementation(tx.impl);

    const result = await service.importBuffer('precedence.xlsx', buffer);
    expect(result).toMatchObject({ created: 1 });

    const created = tx.contactCreateMany[0][0];
    expect(created.phoneE164).toBe('+5592998761234');
    expect(created.name).toBe('NomeWins');
    expect(created.city).toBe('CidadeWins');
    expect(created.group).toBe('GrupoWins');
  });

  it('falls back to EN keys when PT-BR keys are absent', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Contacts');
    ws.addRow(['phone', 'name', 'city', 'group']);
    ws.addRow(['(92) 99876-1234', 'EnName', 'EnCity', 'EnGroup']);
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());

    const tx = makeTxMock();
    prisma.$transaction.mockImplementation(tx.impl);

    await service.importBuffer('en.xlsx', buffer);
    const created = tx.contactCreateMany[0][0];
    expect(created.phoneE164).toBe('+5592998761234');
    expect(created.name).toBe('EnName');
    expect(created.city).toBe('EnCity');
    expect(created.group).toBe('EnGroup');
  });

  it('routes unknown columns into customFields and omits them when none', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Contacts');
    ws.addRow(['telefone', 'nome', 'empresa', 'cargo']);
    ws.addRow(['(92) 99876-1234', 'Jo', 'Acme', 'Dev']);
    ws.addRow(['(92) 99876-1235', 'No Extra']); // only known cols populated
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());

    const tx = makeTxMock();
    prisma.$transaction.mockImplementation(tx.impl);

    await service.importBuffer('custom.xlsx', buffer);
    const [withExtra, withoutExtra] = tx.contactCreateMany[0];
    expect(withExtra.customFields).toEqual({ empresa: 'Acme', cargo: 'Dev' });
    expect(withoutExtra.customFields).toBeUndefined();
  });
});

describe('classification counts (created/updated/invalid/duplicate mix)', () => {
  let service: ExcelService;
  let prisma: { $transaction: ReturnType<typeof vi.fn> };
  let audit: AuditService;
  let syncQueue: { add: ReturnType<typeof vi.fn> };
  let consent: {
    suppressedPhones: ReturnType<typeof vi.fn>;
    rehydrate: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    prisma = { $transaction: vi.fn() };
    audit = {
      log: vi.fn().mockResolvedValue(undefined),
    } as unknown as AuditService;
    syncQueue = { add: vi.fn().mockResolvedValue(undefined) };
    // Ninguém suprimido por padrão — os testes de supressão sobrescrevem.
    consent = {
      suppressedPhones: vi.fn().mockResolvedValue(new Set<string>()),
      rehydrate: vi.fn().mockResolvedValue([]),
    };
    service = new ExcelService(
      prisma as unknown as PrismaService,
      audit,
      syncQueue as unknown as Queue,
      consent as unknown as ConsentService,
    );
  });

  it('counts created, updated, invalid and duplicate rows independently', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Contacts');
    ws.addRow(['telefone', 'nome']);
    ws.addRow(['(92) 99876-1234', 'Existing']); // -> updated (pre-seeded)
    ws.addRow(['(92) 99876-5678', 'New One']); // -> created
    ws.addRow(['(92) 99876-5678', 'New One dup']); // -> duplicate (same phone)
    ws.addRow(['not-a-phone', 'Garbage']); // -> invalid
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());

    const tx = makeTxMock({
      existing: [{ id: 'c-existing', phoneE164: '+5592998761234' }],
    });
    prisma.$transaction.mockImplementation(tx.impl);

    const result = await service.importBuffer('mix.xlsx', buffer);
    expect(result).toMatchObject({
      total: 4,
      created: 1,
      updated: 1,
      invalid: 1,
      duplicates: 1,
    });
  });

  it('records every classified row as an ImportItem with the right status', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Contacts');
    ws.addRow(['telefone', 'nome']);
    ws.addRow(['(92) 99876-1234', 'Existing']);
    ws.addRow(['(92) 99876-5678', 'New One']);
    ws.addRow(['(92) 99876-5678', 'Dup']);
    ws.addRow(['not-a-phone', 'Garbage']);
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());

    const importItemCreateMany: any[][] = [];
    prisma.$transaction.mockImplementation(async (callback: any) => {
      let findCall = 0;
      const tx = {
        importBatch: {
          create: vi.fn().mockResolvedValue({ id: 'batch-1' }),
          update: vi.fn().mockResolvedValue({}),
        },
        contact: {
          findMany: vi.fn().mockImplementation(async (args: any) => {
            findCall++;
            if (findCall === 1) {
              return [{ id: 'c-existing', phoneE164: '+5592998761234' }];
            }
            const phones: string[] = args.where.phoneE164.in;
            return phones.map((p, i) => ({ id: `new-${i}`, phoneE164: p }));
          }),
          createMany: vi
            .fn()
            .mockImplementation(async (args: any) => ({ count: args.data.length })),
          update: vi.fn().mockResolvedValue({ id: 'c-existing' }),
        },
        importItem: {
          createMany: vi.fn().mockImplementation(async (args: any) => {
            importItemCreateMany.push(args.data);
            return { count: args.data.length };
          }),
        },
      };
      return callback(tx);
    });

    await service.importBuffer('items.xlsx', buffer);

    const items = importItemCreateMany[0];
    const byStatus = items.reduce(
      (acc: Record<string, number>, it: any) => {
        acc[it.status] = (acc[it.status] ?? 0) + 1;
        return acc;
      },
      {},
    );
    expect(byStatus).toEqual({
      CREATED: 1,
      UPDATED: 1,
      DUPLICATE: 1,
      INVALID: 1,
    });
    // CREATED/UPDATED carry a contactId; INVALID/DUPLICATE do not.
    const created = items.find((i: any) => i.status === 'CREATED');
    const updated = items.find((i: any) => i.status === 'UPDATED');
    const invalid = items.find((i: any) => i.status === 'INVALID');
    const dup = items.find((i: any) => i.status === 'DUPLICATE');
    expect(created.contactId).toBeTruthy();
    expect(updated.contactId).toBe('c-existing');
    expect(invalid.contactId).toBeNull();
    expect(dup.contactId).toBeNull();
  });
});

describe('U1 — namespace-prefixed xlsx fallback + unreadable workbook error', () => {
  let service: ExcelService;
  let prisma: { $transaction: ReturnType<typeof vi.fn> };
  let audit: AuditService;
  let syncQueue: { add: ReturnType<typeof vi.fn> };
  let consent: {
    suppressedPhones: ReturnType<typeof vi.fn>;
    rehydrate: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    prisma = { $transaction: vi.fn() };
    audit = {
      log: vi.fn().mockResolvedValue(undefined),
    } as unknown as AuditService;
    syncQueue = { add: vi.fn().mockResolvedValue(undefined) };
    // Ninguém suprimido por padrão — os testes de supressão sobrescrevem.
    consent = {
      suppressedPhones: vi.fn().mockResolvedValue(new Set<string>()),
      rehydrate: vi.fn().mockResolvedValue([]),
    };
    service = new ExcelService(
      prisma as unknown as PrismaService,
      audit,
      syncQueue as unknown as Queue,
      consent as unknown as ConsentService,
    );
  });

  /**
   * Minimal .xlsx reproducing the client file exceljs 4.4 cannot read:
   * namespace-PREFIXED elements (<x:workbook>…) + ABSOLUTE .rels Targets.
   * Local duplicate of the builder in xlsx-normalizer.spec.ts.
   */
  async function makePrefixedXlsx(): Promise<Buffer> {
    const MAIN_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
    const REL_NS =
      'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
    const PKG_REL_NS =
      'http://schemas.openxmlformats.org/package/2006/relationships';
    const CT_NS =
      'http://schemas.openxmlformats.org/package/2006/content-types';

    const { default: JSZip } = await import('jszip');
    const zip = new JSZip();
    zip.file(
      '[Content_Types].xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Types xmlns="${CT_NS}">` +
        `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
        `<Default Extension="xml" ContentType="application/xml"/>` +
        `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
        `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
        `</Types>`,
    );
    zip.file(
      '_rels/.rels',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="${PKG_REL_NS}">` +
        `<Relationship Id="rId1" Type="${REL_NS}/officeDocument" Target="/xl/workbook.xml"/>` +
        `</Relationships>`,
    );
    zip.file(
      'xl/workbook.xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<x:workbook xmlns:x="${MAIN_NS}" xmlns:r="${REL_NS}">` +
        `<x:sheets>` +
        `<x:sheet name="Contatos" sheetId="1" r:id="Rabc"/>` +
        `</x:sheets>` +
        `</x:workbook>`,
    );
    zip.file(
      'xl/_rels/workbook.xml.rels',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="${PKG_REL_NS}">` +
        `<Relationship Id="Rabc" Type="${REL_NS}/worksheet" Target="/xl/worksheets/sheet1.xml"/>` +
        `</Relationships>`,
    );
    zip.file(
      'xl/worksheets/sheet1.xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<x:worksheet xmlns:x="${MAIN_NS}">` +
        `<x:sheetData>` +
        `<x:row r="1">` +
        `<x:c r="A1" t="inlineStr"><x:is><x:t>telefone</x:t></x:is></x:c>` +
        `<x:c r="B1" t="inlineStr"><x:is><x:t>nome</x:t></x:is></x:c>` +
        `</x:row>` +
        `<x:row r="2">` +
        `<x:c r="A2" t="inlineStr"><x:is><x:t>(92) 99876-1234</x:t></x:is></x:c>` +
        `<x:c r="B2" t="inlineStr"><x:is><x:t>Maria Silva</x:t></x:is></x:c>` +
        `</x:row>` +
        `</x:sheetData>` +
        `</x:worksheet>`,
    );
    return zip.generateAsync({ type: 'nodebuffer' });
  }

  it('imports a namespace-prefixed/absolute-target workbook via the normalize retry', async () => {
    const buffer = await makePrefixedXlsx();

    const tx = makeTxMock();
    prisma.$transaction.mockImplementation(tx.impl);

    const result = await service.importBuffer('prefixed.xlsx', buffer);
    expect(result).toMatchObject({ total: 1, created: 1, invalid: 0 });

    const created = tx.contactCreateMany[0][0];
    expect(created.phoneE164).toBe('+5592998761234');
    expect(created.name).toBe('Maria Silva');
  });

  it('rejects a garbage buffer with the friendly UnreadableWorkbookError (422)', async () => {
    const buffer = Buffer.from('not an xlsx');

    await expect(
      service.importBuffer('garbage.xlsx', buffer),
    ).rejects.toMatchObject({
      code: 'excel.unreadable_workbook',
      status: 422,
      message:
        'Não foi possível ler o arquivo .xlsx. Abra-o no Excel ou Google Sheets, salve novamente como .xlsx e tente importar de novo.',
      detail: expect.any(String),
    });
    // Parse failure happens before any batch work.
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

/**
 * C1 — a supressão tem de sobreviver à planilha.
 *
 * Este era o bug latente: `optedOut` morava na linha de Contact. Um contato que
 * deu PARAR e fosse reimportado (linha recriada, ou o mesmo XLSX rodado de novo)
 * voltava a nascer com optedOut=false e VOLTAVA A RECEBER — revogação silenciosa
 * revertida por um upload de planilha (art. 8º §5º: revogação é a qualquer
 * momento, por procedimento gratuito e facilitado; não existe "até o próximo
 * import"). Agora a fonte da verdade é a SuppressionList, chaveada por phoneHash
 * e desacoplada de Contact.
 */
describe('C1 — importação respeita a SuppressionList', () => {
  let service: ExcelService;
  let prisma: { $transaction: ReturnType<typeof vi.fn> };
  let audit: AuditService;
  let syncQueue: { add: ReturnType<typeof vi.fn> };
  let consent: {
    suppressedPhones: ReturnType<typeof vi.fn>;
    rehydrate: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    prisma = { $transaction: vi.fn() };
    audit = { log: vi.fn().mockResolvedValue(undefined) } as unknown as AuditService;
    syncQueue = { add: vi.fn().mockResolvedValue(undefined) };
    consent = {
      suppressedPhones: vi.fn().mockResolvedValue(new Set<string>()),
      rehydrate: vi.fn().mockResolvedValue([]),
    };
    service = new ExcelService(
      prisma as unknown as PrismaService,
      audit,
      syncQueue as unknown as Queue,
      consent as unknown as ConsentService,
    );
  });

  it('contato suprimido reimportado como linha NOVA nasce optedOut=true (não ressuscita)', async () => {
    const buffer = await makeWorkbook(2);
    // A 1ª linha da planilha é o contato que deu PARAR e teve a linha apagada.
    consent.suppressedPhones.mockResolvedValue(new Set(['+5592998761000']));
    const tx = makeTxMock();
    prisma.$transaction.mockImplementation(tx.impl);

    await service.importBuffer('reimport.xlsx', buffer);

    const created = tx.contactCreateMany[0];
    expect(created).toHaveLength(2);
    expect(created.find((c: any) => c.phoneE164 === '+5592998761000')).toMatchObject({
      optedOut: true,
    });
    // O outro contato não é afetado.
    expect(created.find((c: any) => c.phoneE164 === '+5592998761001')).toMatchObject({
      optedOut: false,
    });
  });

  it('contato suprimido que AINDA existe é reafirmado optedOut=true (repara cache velho)', async () => {
    const buffer = await makeWorkbook(1);
    consent.suppressedPhones.mockResolvedValue(new Set(['+5592998761000']));
    const tx = makeTxMock({
      existing: [{ id: 'c-supr', phoneE164: '+5592998761000' }],
    });
    prisma.$transaction.mockImplementation(tx.impl);

    await service.importBuffer('reimport.xlsx', buffer);

    const update = tx.updateManyCalls.find(
      (u: any) => u.where.id === 'c-supr',
    );
    expect(update.data).toMatchObject({ optedOut: true });
  });

  it('a planilha NUNCA escreve optedOut=false num contato existente', async () => {
    const buffer = await makeWorkbook(1);
    consent.suppressedPhones.mockResolvedValue(new Set());
    const tx = makeTxMock({
      existing: [{ id: 'c1', phoneE164: '+5592998761000' }],
    });
    prisma.$transaction.mockImplementation(tx.impl);

    await service.importBuffer('normal.xlsx', buffer);

    const update = tx.updateManyCalls[0];
    // Ausente, não `false`: um import não é um ato de consentimento, e não pode
    // desfazer um opt-out (nem por acidente, nem por coluna esquecida).
    expect(update.data).not.toHaveProperty('optedOut');
  });

  it('consulta a supressão em LOTE, antes de abrir a transação', async () => {
    const buffer = await makeWorkbook(3);
    const tx = makeTxMock();
    prisma.$transaction.mockImplementation(tx.impl);

    await service.importBuffer('bulk.xlsx', buffer);

    expect(consent.suppressedPhones).toHaveBeenCalledTimes(1);
    expect(consent.suppressedPhones).toHaveBeenCalledWith([
      '+5592998761000',
      '+5592998761001',
      '+5592998761002',
    ]);
  });
});

describe('A8 deeper — async batch lifecycle', () => {
  let service: ExcelService;
  let prisma: {
    $transaction: ReturnType<typeof vi.fn>;
    importBatch: {
      create: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    };
  };
  let audit: AuditService;
  let syncQueue: { add: ReturnType<typeof vi.fn> };
  let consent: {
    suppressedPhones: ReturnType<typeof vi.fn>;
    rehydrate: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    prisma = {
      $transaction: vi.fn(),
      importBatch: {
        create: vi.fn(),
        update: vi.fn().mockResolvedValue({}),
      },
    };
    audit = {
      log: vi.fn().mockResolvedValue(undefined),
    } as unknown as AuditService;
    syncQueue = { add: vi.fn().mockResolvedValue(undefined) };
    // Ninguém suprimido por padrão — os testes de supressão sobrescrevem.
    consent = {
      suppressedPhones: vi.fn().mockResolvedValue(new Set<string>()),
      rehydrate: vi.fn().mockResolvedValue([]),
    };
    service = new ExcelService(
      prisma as unknown as PrismaService,
      audit,
      syncQueue as unknown as Queue,
      consent as unknown as ConsentService,
    );
  });

  it('createPendingBatch inserts a PENDING ImportBatch and returns its id', async () => {
    prisma.importBatch.create.mockResolvedValue({ id: 'pending-1' });
    const batch = await service.createPendingBatch('contacts.xlsx');
    expect(batch.id).toBe('pending-1');
    expect(prisma.importBatch.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { filename: 'contacts.xlsx', status: 'PENDING' },
      }),
    );
  });

  it('markProcessing flips the batch to PROCESSING', async () => {
    await service.markProcessing('b1');
    expect(prisma.importBatch.update).toHaveBeenCalledWith({
      where: { id: 'b1' },
      data: { status: 'PROCESSING' },
    });
  });

  it('markCompleted writes COMPLETED + the summary', async () => {
    const summary = {
      total: 3,
      created: 2,
      updated: 1,
      invalid: 0,
      duplicates: 0,
    };
    await service.markCompleted('b1', summary);
    expect(prisma.importBatch.update).toHaveBeenCalledWith({
      where: { id: 'b1' },
      data: { status: 'COMPLETED', summary },
    });
  });

  it('markFailed writes FAILED + the error message into errors', async () => {
    await service.markFailed('b1', 'boom: bad file');
    const call = prisma.importBatch.update.mock.calls[0][0];
    expect(call.where).toEqual({ id: 'b1' });
    expect(call.data.status).toBe('FAILED');
    expect(JSON.stringify(call.data.errors)).toContain('boom: bad file');
  });

  it('importBuffer reuses an existing batchId (does NOT create a new batch row)', async () => {
    const buffer = await makeWorkbook(3);

    let createCalled = false;
    prisma.$transaction.mockImplementation(async (callback: any) => {
      let findCall = 0;
      const tx = {
        importBatch: {
          create: vi.fn().mockImplementation(async () => {
            createCalled = true;
            return { id: 'should-not-be-used' };
          }),
          update: vi.fn().mockResolvedValue({ id: 'existing-batch' }),
        },
        contact: {
          findMany: vi.fn().mockImplementation(async (args: any) => {
            findCall++;
            if (findCall === 1) return [];
            const phones: string[] = args.where.phoneE164.in;
            return phones.map((p, i) => ({ id: `c${i}`, phoneE164: p }));
          }),
          createMany: vi
            .fn()
            .mockImplementation(async (args: any) => ({
              count: args.data.length,
            })),
          update: vi.fn().mockResolvedValue({ id: 'x' }),
        },
        importItem: { createMany: vi.fn().mockResolvedValue({ count: 3 }) },
      };
      return callback(tx);
    });

    const result = await service.importBuffer('reuse.xlsx', buffer, {
      batchId: 'existing-batch',
    });

    // It must operate on the existing batch, not create a fresh one.
    expect(createCalled).toBe(false);
    expect(result).toMatchObject({
      batchId: 'existing-batch',
      total: 3,
      created: 3,
    });
  });
});

/**
 * C4 — consentimento coletado no papel/presencial, importado por planilha
 * (spec §3.3). Três invariantes, e cada uma fecha um jeito diferente de o
 * sistema inventar consentimento.
 */
describe('C4 — importação de consentimento presencial (§3.3)', () => {
  let service: ExcelService;
  let prisma: { $transaction: ReturnType<typeof vi.fn> };
  let audit: AuditService;
  let syncQueue: { add: ReturnType<typeof vi.fn> };
  let consent: {
    suppressedPhones: ReturnType<typeof vi.fn>;
    rehydrate: ReturnType<typeof vi.fn>;
    record: ReturnType<typeof vi.fn>;
    findActivePurpose: ReturnType<typeof vi.fn>;
  };

  /** tx que resolve os ids dos contatos criados (2ª findMany devolve os inseridos). */
  function txWithInserts(existing: Array<{ id: string; phoneE164: string }> = []) {
    return async (callback: any) => {
      let findCall = 0;
      const tx = {
        importBatch: {
          create: vi.fn().mockResolvedValue({ id: 'batch-1' }),
          update: vi.fn().mockResolvedValue({ id: 'batch-1' }),
        },
        contact: {
          findMany: vi.fn().mockImplementation(async (args: any) => {
            findCall++;
            if (findCall === 1) return existing;
            const phones: string[] = args.where.phoneE164.in;
            return phones.map((p, i) => ({ id: `c-${i}`, phoneE164: p }));
          }),
          createMany: vi
            .fn()
            .mockImplementation(async (args: any) => ({ count: args.data.length })),
          update: vi
            .fn()
            .mockImplementation(async (args: any) => ({ id: 'c-existing', ...args.where })),
        },
        importItem: { createMany: vi.fn().mockResolvedValue({ count: 0 }) },
      };
      return callback(tx);
    };
  }

  /** Planilha de campo: telefone + as colunas de consentimento do §3.3. */
  async function paperWorkbook(over: Record<string, string> = {}) {
    const row = {
      telefone: '(92) 98765-4321',
      nome: 'Maria da Silva',
      consentimento: 'SIM',
      termo_ref: 'TERMO-CAMPO-2026-A',
      finalidade: 'convite_atividades',
      data_coleta: '2026-03-15',
      evento_local: 'Mutirão de Parintins',
      link_scan: 'https://drive.exemplo.org/fichas/123.pdf',
      ...over,
    };
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Fichas');
    ws.addRow(Object.keys(row));
    ws.addRow(Object.values(row));
    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  beforeEach(() => {
    prisma = { $transaction: vi.fn() };
    audit = { log: vi.fn().mockResolvedValue(undefined) } as unknown as AuditService;
    syncQueue = { add: vi.fn().mockResolvedValue(undefined) };
    consent = {
      suppressedPhones: vi.fn().mockResolvedValue(new Set<string>()),
      rehydrate: vi.fn().mockResolvedValue([]),
      record: vi.fn().mockResolvedValue({ eventId: 'ev1', created: true }),
      findActivePurpose: vi.fn().mockResolvedValue({
        key: 'convite_atividades',
        label: 'Convites para cursos, oficinas e eventos',
        description: 'Inscrições, chamadas e mutirões.',
        isSensitive: false,
      }),
    };
    service = new ExcelService(
      prisma as unknown as PrismaService,
      audit,
      syncQueue as unknown as Queue,
      consent as unknown as ConsentService,
    );
  });

  it('consentimento SIM → GRANT (PAPER_FORM) com a evidência do §2.4 e o operador que importou', async () => {
    prisma.$transaction.mockImplementation(txWithInserts());

    const result = await service.importBuffer('fichas.xlsx', await paperWorkbook(), {
      batchId: 'batch-1',
      actorUserId: 'user-operador',
    });

    expect(result).toMatchObject({ created: 1, consentGranted: 1 });
    expect(consent.record).toHaveBeenCalledOnce();

    const arg = consent.record.mock.calls[0][0];
    expect(arg).toMatchObject({
      contactId: 'c-0',
      phoneE164: '+5592987654321',
      purposeKey: 'convite_atividades',
      action: ConsentAction.GRANT,
      source: ConsentSource.PAPER_FORM,
      actorUserId: 'user-operador',
      // A versão do termo ASSINADO, não a de um texto de tela.
      consentTextVersion: 'TERMO-CAMPO-2026-A',
    });
    // occurredAt = a data da assinatura (não a do import). É o que faz a regra
    // de frescor de 90 dias do §3.3 significar alguma coisa.
    expect((arg.occurredAt as Date).toISOString().slice(0, 10)).toBe('2026-03-15');
    // O texto aponta para o artefato físico — não finge saber o que estava escrito nele.
    expect(arg.evidenceText).toContain('TERMO-CAMPO-2026-A');
    expect(arg.evidenceText).toContain('ficha de papel assinada');
    expect(arg.evidence).toMatchObject({
      termRef: 'TERMO-CAMPO-2026-A',
      eventName: 'Mutirão de Parintins',
      scanUrl: 'https://drive.exemplo.org/fichas/123.pdf',
      importBatchId: 'batch-1',
      importFilename: 'fichas.xlsx',
      rowNumber: 2,
      actorUserId: 'user-operador',
    });
    expect(arg.evidence.rawRow).toMatchObject({ termo_ref: 'TERMO-CAMPO-2026-A' });
  });

  it('planilha SEM coluna de consentimento → contato importado, ZERO consentimento', async () => {
    prisma.$transaction.mockImplementation(txWithInserts());
    const buffer = await makeWorkbook(2); // telefone/nome/cidade, nada de consentimento

    const result = await service.importBuffer('contatos.xlsx', buffer);

    expect(result).toMatchObject({ created: 2, consentGranted: 0 });
    expect(consent.record).not.toHaveBeenCalled();
  });

  /**
   * C5.3 — o contato CRIADO pela planilha reidrata o consentimento da trilha do
   * seu phoneHash. Sem isto, quem consentiu, foi excluído e voltou pela planilha
   * renasce sem consentimento (a supressão sobrevive; os GRANTs, não) — e o gate,
   * corretamente, o pula. O consentimento existia e o orgamind não o enxergava.
   */
  it('contato NOVO reidrata o consentimento da trilha do phoneHash (delete → reimport)', async () => {
    prisma.$transaction.mockImplementation(txWithInserts());
    const buffer = await makeWorkbook(2);

    await service.importBuffer('contatos.xlsx', buffer);

    expect(consent.rehydrate).toHaveBeenCalledTimes(2);
    expect(consent.rehydrate).toHaveBeenCalledWith('c-0', '+5592998761000');
  });

  it('contato que JÁ EXISTIA não é reidratado — o estado derivado dele está vivo', async () => {
    prisma.$transaction.mockImplementation(
      txWithInserts([{ id: 'c-existing', phoneE164: '+5592998761000' }]),
    );
    const buffer = await makeWorkbook(1);

    await service.importBuffer('contatos.xlsx', buffer);

    expect(consent.rehydrate).not.toHaveBeenCalled();
  });

  it('contato SUPRIMIDO → não consente e CONTINUA suprimido, mesmo com SIM na ficha', async () => {
    prisma.$transaction.mockImplementation(txWithInserts());
    consent.suppressedPhones.mockResolvedValue(new Set(['+5592987654321']));

    const result = await service.importBuffer('fichas.xlsx', await paperWorkbook(), {
      batchId: 'batch-1',
      actorUserId: 'user-operador',
    });

    // record(GRANT) LEVANTARIA a supressão (regra 4 do §2.7). Reimportar uma
    // ficha antiga não pode desfazer um PARAR dado depois dela — a revogação é
    // durável, e é o único jeito de a planilha não ressuscitar quem saiu.
    expect(consent.record).not.toHaveBeenCalled();
    expect(result).toMatchObject({ consentGranted: 0, consentSuppressed: 1 });
  });

  it('a finalidade pode vir como PARÂMETRO do import quando a planilha não tem a coluna', async () => {
    prisma.$transaction.mockImplementation(txWithInserts());
    consent.findActivePurpose.mockResolvedValue({
      key: 'captacao_recursos',
      label: 'Campanhas de doação e apoio',
      description: 'Arrecadação de recursos.',
      isSensitive: false,
    });

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Fichas');
    ws.addRow(['telefone', 'consentimento', 'termo_ref', 'data_coleta']);
    ws.addRow(['(92) 98765-4321', 'SIM', 'TERMO-DOACAO-01', '2026-05-02']);
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());

    await service.importBuffer('doacao.xlsx', buffer, {
      batchId: 'batch-1',
      purposeKey: 'captacao_recursos',
    });

    expect(consent.record).toHaveBeenCalledWith(
      expect.objectContaining({ purposeKey: 'captacao_recursos' }),
    );
  });

  it('finalidade INEXISTENTE/inativa → nenhum GRANT (nunca se inventa finalidade)', async () => {
    prisma.$transaction.mockImplementation(txWithInserts());
    consent.findActivePurpose.mockResolvedValue(null);

    const result = await service.importBuffer(
      'fichas.xlsx',
      await paperWorkbook({ finalidade: 'finalidade_que_nao_existe' }),
      { batchId: 'batch-1' },
    );

    expect(consent.record).not.toHaveBeenCalled();
    expect(result).toMatchObject({ created: 1, consentGranted: 0, consentIncomplete: 1 });
  });

  it('consentimento SIM sem termo assinado → contato entra, consentimento NÃO', async () => {
    prisma.$transaction.mockImplementation(txWithInserts());

    const result = await service.importBuffer(
      'fichas.xlsx',
      await paperWorkbook({ termo_ref: '' }),
      { batchId: 'batch-1' },
    );

    expect(consent.record).not.toHaveBeenCalled();
    expect(result).toMatchObject({ created: 1, consentGranted: 0, consentIncomplete: 1 });
  });

  it('as colunas de consentimento NÃO vazam para customFields (são evidência, não campo solto)', async () => {
    const contactCreateMany: any[][] = [];
    prisma.$transaction.mockImplementation(async (callback: any) => {
      let findCall = 0;
      const tx = {
        importBatch: {
          create: vi.fn().mockResolvedValue({ id: 'batch-1' }),
          update: vi.fn().mockResolvedValue({ id: 'batch-1' }),
        },
        contact: {
          findMany: vi.fn().mockImplementation(async (args: any) => {
            findCall++;
            if (findCall === 1) return [];
            const phones: string[] = args.where.phoneE164.in;
            return phones.map((p, i) => ({ id: `c-${i}`, phoneE164: p }));
          }),
          createMany: vi.fn().mockImplementation(async (args: any) => {
            contactCreateMany.push(args.data);
            return { count: args.data.length };
          }),
          update: vi.fn().mockResolvedValue({ id: 'x' }),
        },
        importItem: { createMany: vi.fn().mockResolvedValue({ count: 0 }) },
      };
      return callback(tx);
    });

    await service.importBuffer('fichas.xlsx', await paperWorkbook(), { batchId: 'batch-1' });

    expect(contactCreateMany[0][0].customFields).toBeUndefined();
  });
});
