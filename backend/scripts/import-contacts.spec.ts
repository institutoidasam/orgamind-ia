import { describe, it, expect } from 'vitest';
import { mockDeep } from 'vitest-mock-extended';
import { Prisma } from '@prisma/client';
import type { PrismaService } from '../src/shared/prisma/prisma.service';
import { importContacts, parseContactLine } from './import-contacts';

function mkPrisma() {
  const prisma = mockDeep<PrismaService>();
  // Same $transaction-as-passthrough pattern used across the repo's repository
  // specs (see segments.repository.spec.ts): the callback receives `prisma`
  // itself, so tx.contact.* calls land on the same mocked delegate.
  prisma.$transaction.mockImplementation((arg: unknown) =>
    Array.isArray(arg) ? Promise.all(arg) : (arg as (tx: typeof prisma) => unknown)(prisma),
  );
  return prisma;
}

describe('parseContactLine', () => {
  it('parses a valid JSONL line', () => {
    const r = parseContactLine('{"phoneE164":"+5592900000001","name":"Maria"}');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.phoneE164).toBe('+5592900000001');
  });

  it('rejects broken JSON', () => {
    expect(parseContactLine('{not json').ok).toBe(false);
  });

  it('rejects a line without phoneE164', () => {
    expect(parseContactLine('{"name":"Maria"}').ok).toBe(false);
  });

  it('rejects a line with an empty phoneE164', () => {
    expect(parseContactLine('{"phoneE164":"  "}').ok).toBe(false);
  });

  it('rejects a JSON array (not an object)', () => {
    expect(parseContactLine('[1,2,3]').ok).toBe(false);
  });
});

describe('importContacts', () => {
  it('creates a new contact and counts it under created', async () => {
    const prisma = mkPrisma();
    prisma.contact.findFirst.mockResolvedValue(null);
    prisma.contact.create.mockResolvedValue({ id: 'c1' } as never);

    const summary = await importContacts(prisma, ['{"phoneE164":"+5592900000001","name":"Maria"}'], {
      log: () => {},
    });

    expect(summary).toEqual({ created: 1, updated: 0, skipped: 0, total: 1 });
    expect(prisma.contact.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ phoneE164: '+5592900000001', name: 'Maria' }),
    });
  });

  it('is idempotent: importing the same line twice does not create a duplicate', async () => {
    const prisma = mkPrisma();
    const line = '{"phoneE164":"+5592900000001","name":"Maria"}';

    // First run: contact does not exist yet.
    prisma.contact.findFirst.mockResolvedValueOnce(null);
    prisma.contact.create.mockResolvedValueOnce({ id: 'c1' } as never);
    const first = await importContacts(prisma, [line], { log: () => {} });
    expect(first).toEqual({ created: 1, updated: 0, skipped: 0, total: 1 });

    // Second run: contact now exists (state after the first run) -> update, not create.
    prisma.contact.findFirst.mockResolvedValueOnce({ id: 'c1', phoneE164: '+5592900000001' } as never);
    prisma.contact.update.mockResolvedValueOnce({ id: 'c1' } as never);
    const second = await importContacts(prisma, [line], { log: () => {} });
    expect(second).toEqual({ created: 0, updated: 1, skipped: 0, total: 1 });

    expect(prisma.contact.create).toHaveBeenCalledTimes(1);
    expect(prisma.contact.update).toHaveBeenCalledTimes(1);
  });

  /**
   * O QUARTO ESCRITOR DE CONTATO (auditoria C5/C6).
   *
   * Este script casava o titular por igualdade EXATA de `phoneE164`. Um JSONL com
   * a grafia de 12 dígitos de alguém que já está na base com 13 (ou vice-versa)
   * criava um SEGUNDO Contact para a MESMA conta de WhatsApp — e o gêmeo não fica
   * inerte: `ConsentService.rehydrate` casa a trilha pelas duas grafias, ele nasce
   * GRANTED e passa o gate. Numa campanha eleitoral, a pessoa recebe duas vezes.
   */
  it('não cria gêmeo: a OUTRA grafia do 9º dígito é o MESMO titular, e a atualização é por id', async () => {
    const prisma = mkPrisma();
    prisma.contact.findFirst.mockResolvedValue({ id: 'c-ja-existe', phoneE164: '+5592995550101' } as never);
    prisma.contact.update.mockResolvedValue({ id: 'c-ja-existe' } as never);

    const summary = await importContacts(prisma, ['{"phoneE164":"+559295550101","name":"Katarina"}'], {
      log: () => {},
    });

    expect(summary).toEqual({ created: 0, updated: 1, skipped: 0, total: 1 });
    expect(prisma.contact.create).not.toHaveBeenCalled();
    // Por `id`: a grafia consultada não é a gravada, então `where: { phoneE164 }`
    // atualizaria a linha errada — ou nenhuma.
    expect(prisma.contact.update).toHaveBeenCalledWith({
      where: { id: 'c-ja-existe' },
      data: expect.objectContaining({ name: 'Katarina' }),
    });
  });

  it('procura o titular pelas DUAS grafias, não pela string exata', async () => {
    const prisma = mkPrisma();
    prisma.contact.findFirst.mockResolvedValue(null);
    prisma.contact.create.mockResolvedValue({ id: 'c1' } as never);

    await importContacts(prisma, ['{"phoneE164":"+5592995550101"}'], { log: () => {} });

    expect(prisma.contact.findFirst).toHaveBeenCalledWith({
      where: { phoneE164: { in: expect.arrayContaining(['+5592995550101', '+559295550101']) } },
      select: { id: true, phoneE164: true },
    });
  });

  it('uma criação que perde a corrida (P2002) vira atualização, não erro', async () => {
    const prisma = mkPrisma();
    // Ninguém na base no instante da busca…
    prisma.contact.findFirst.mockResolvedValue(null);
    // …mas outro escritor gravou a mesma string antes do create.
    prisma.contact.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('unique', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );
    prisma.contact.update.mockResolvedValue({ id: 'c1' } as never);

    const summary = await importContacts(prisma, ['{"phoneE164":"+5592900000001"}'], { log: () => {} });

    expect(summary).toEqual({ created: 0, updated: 1, skipped: 0, total: 1 });
    expect(prisma.contact.update).toHaveBeenCalledWith({
      where: { phoneE164: '+5592900000001' },
      data: expect.any(Object),
    });
  });

  it('skips an invalid line without aborting the rest of the file', async () => {
    const prisma = mkPrisma();
    prisma.contact.findFirst.mockResolvedValue(null);
    prisma.contact.create.mockResolvedValue({ id: 'c1' } as never);

    const summary = await importContacts(
      prisma,
      ['not json at all', '{"phoneE164":"+5592900000001"}', '{"name":"sem telefone"}'],
      { log: () => {} },
    );

    expect(summary).toEqual({ created: 1, updated: 0, skipped: 2, total: 3 });
    expect(prisma.contact.create).toHaveBeenCalledTimes(1);
  });

  it('--dry-run reports counts without writing to the database', async () => {
    const prisma = mkPrisma();
    prisma.contact.findFirst.mockResolvedValue(null);

    const summary = await importContacts(
      prisma,
      ['{"phoneE164":"+5592900000001"}', '{"phoneE164":"+5592900000002"}'],
      { dryRun: true, log: () => {} },
    );

    expect(summary).toEqual({ created: 2, updated: 0, skipped: 0, total: 2 });
    expect(prisma.contact.create).not.toHaveBeenCalled();
    expect(prisma.contact.update).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('runs exactly one transaction per batch', async () => {
    const prisma = mkPrisma();
    prisma.contact.findFirst.mockResolvedValue(null);
    prisma.contact.create.mockResolvedValue({ id: 'x' } as never);

    const lines = [
      '{"phoneE164":"+5592900000001"}',
      '{"phoneE164":"+5592900000002"}',
      '{"phoneE164":"+5592900000003"}',
    ];
    await importContacts(prisma, lines, { batchSize: 2, log: () => {} });

    expect(prisma.$transaction).toHaveBeenCalledTimes(2); // batch of 2 + batch of 1
    expect(prisma.contact.create).toHaveBeenCalledTimes(3);
  });

  it('accepts an async iterable of lines (e.g. a readline interface) and ignores blank lines', async () => {
    const prisma = mkPrisma();
    prisma.contact.findFirst.mockResolvedValue(null);
    prisma.contact.create.mockResolvedValue({ id: 'c1' } as never);

    async function* lines() {
      yield '{"phoneE164":"+5592900000001"}';
      yield '';
      yield '{"phoneE164":"+5592900000002"}';
    }

    const summary = await importContacts(prisma, lines(), { log: () => {} });

    expect(summary.total).toBe(2); // blank line not counted at all
    expect(summary.created).toBe(2);
  });
});
