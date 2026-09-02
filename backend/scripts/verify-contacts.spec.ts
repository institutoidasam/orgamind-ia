import { describe, it, expect } from 'vitest';
import { mockDeep } from 'vitest-mock-extended';
import type { PrismaService } from '../src/shared/prisma/prisma.service';
import type { ParsedContactLine } from './import-contacts';
import { verifyContacts } from './verify-contacts';

function row(overrides: Partial<ParsedContactLine> = {}): ParsedContactLine {
  return {
    id: 'c1',
    phoneE164: '+5592900000001',
    name: 'Maria',
    city: 'Manaus',
    group: 'alunos',
    tags: ['vip'],
    customFields: { origem: 'planilha' },
    optedOut: false,
    whatsappValid: false,
    whatsappCheckedAt: '2026-01-01T00:00:00.000Z',
    profilePictureUrl: null,
    waLabels: ['cliente'],
    createdAt: '2025-12-01T00:00:00.000Z',
    updatedAt: '2025-12-02T00:00:00.000Z',
    ...overrides,
  };
}

/** DB row that mirrors a ParsedContactLine exactly (defaults resolved like the importer would). */
function dbRowMatching(r: ParsedContactLine) {
  return {
    id: r.id,
    phoneE164: r.phoneE164,
    name: r.name ?? null,
    city: r.city ?? null,
    group: r.group ?? null,
    tags: r.tags ?? [],
    customFields: r.customFields ?? null,
    optedOut: r.optedOut ?? false,
    whatsappValid: r.whatsappValid ?? null,
    waLabels: r.waLabels ?? [],
  };
}

describe('verifyContacts', () => {
  it('passes when counts, invariants and the sample all match', async () => {
    const prisma = mockDeep<PrismaService>();
    const rows = [
      row({ id: 'c1', phoneE164: '+5592900000001', optedOut: false, whatsappValid: false }),
      row({ id: 'c2', phoneE164: '+5592900000002', optedOut: true, whatsappValid: true }),
    ];

    prisma.contact.count
      .mockResolvedValueOnce(2) // count(*)
      .mockResolvedValueOnce(1) // optedOut
      .mockResolvedValueOnce(1); // whatsappValid
    prisma.contact.findUnique.mockImplementation(
      (args: unknown) =>
        Promise.resolve(
          dbRowMatching(
            rows.find((r) => r.phoneE164 === (args as { where: { phoneE164: string } }).where.phoneE164)!,
          ),
        ) as never,
    );

    const report = await verifyContacts(prisma, rows, { sampleSize: 2 });

    expect(report.ok).toBe(true);
    expect(report.errors).toEqual([]);
    expect(report.sampleMismatches).toEqual([]);
    expect(report.sampleSize).toBe(2);
  });

  it('fails when db count(*) does not match the file total', async () => {
    const prisma = mockDeep<PrismaService>();
    const rows = [row({ optedOut: false, whatsappValid: false })];

    prisma.contact.count
      .mockResolvedValueOnce(0) // count(*) mismatch: db=0, file=1
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0);
    prisma.contact.findUnique.mockResolvedValue(dbRowMatching(rows[0]) as never);

    const report = await verifyContacts(prisma, rows, { sampleSize: 1 });

    expect(report.ok).toBe(false);
    expect(report.errors.some((e) => e.includes('count(*)'))).toBe(true);
  });

  it('fails when the optedOut invariant diverges', async () => {
    const prisma = mockDeep<PrismaService>();
    const rows = [row({ optedOut: true, whatsappValid: false })];

    prisma.contact.count
      .mockResolvedValueOnce(1) // count(*) matches
      .mockResolvedValueOnce(0) // optedOut mismatch: db=0, file=1
      .mockResolvedValueOnce(0); // whatsappValid matches
    prisma.contact.findUnique.mockResolvedValue(dbRowMatching(rows[0]) as never);

    const report = await verifyContacts(prisma, rows, { sampleSize: 1 });

    expect(report.ok).toBe(false);
    expect(report.errors.some((e) => e.includes('optedOut'))).toBe(true);
  });

  it('fails when the whatsappValid invariant diverges', async () => {
    const prisma = mockDeep<PrismaService>();
    const rows = [row({ optedOut: false, whatsappValid: true })];

    prisma.contact.count
      .mockResolvedValueOnce(1) // count(*) matches
      .mockResolvedValueOnce(0) // optedOut matches
      .mockResolvedValueOnce(0); // whatsappValid mismatch: db=0, file=1
    prisma.contact.findUnique.mockResolvedValue(dbRowMatching(rows[0]) as never);

    const report = await verifyContacts(prisma, rows, { sampleSize: 1 });

    expect(report.ok).toBe(false);
    expect(report.errors.some((e) => e.includes('whatsappValid'))).toBe(true);
  });

  it('fails and reports a field-level mismatch found during sampling', async () => {
    const prisma = mockDeep<PrismaService>();
    const rows = [row({ tags: ['vip'] })];

    prisma.contact.count.mockResolvedValueOnce(1).mockResolvedValueOnce(0).mockResolvedValueOnce(0);
    prisma.contact.findUnique.mockResolvedValue({
      ...dbRowMatching(rows[0]),
      tags: ['diferente'],
    } as never);

    const report = await verifyContacts(prisma, rows, { sampleSize: 1 });

    expect(report.ok).toBe(false);
    expect(report.sampleMismatches).toEqual([
      expect.objectContaining({ phoneE164: rows[0].phoneE164, field: 'tags', expected: ['vip'], actual: ['diferente'] }),
    ]);
  });

  it('flags a sampled contact missing from the database', async () => {
    const prisma = mockDeep<PrismaService>();
    const rows = [row()];

    prisma.contact.count.mockResolvedValueOnce(1).mockResolvedValueOnce(0).mockResolvedValueOnce(0);
    prisma.contact.findUnique.mockResolvedValue(null);

    const report = await verifyContacts(prisma, rows, { sampleSize: 1 });

    expect(report.ok).toBe(false);
    expect(report.sampleMismatches[0]).toEqual(
      expect.objectContaining({ phoneE164: rows[0].phoneE164, field: '(row)' }),
    );
  });

  it('caps the sample at the file size even when a larger sampleSize is requested', async () => {
    const prisma = mockDeep<PrismaService>();
    const rows = [
      row({ id: 'c1', phoneE164: '+5592900000001' }),
      row({ id: 'c2', phoneE164: '+5592900000002' }),
    ];

    prisma.contact.count.mockResolvedValueOnce(2).mockResolvedValueOnce(0).mockResolvedValueOnce(0);
    prisma.contact.findUnique.mockImplementation(
      (args: unknown) =>
        Promise.resolve(
          dbRowMatching(
            rows.find((r) => r.phoneE164 === (args as { where: { phoneE164: string } }).where.phoneE164)!,
          ),
        ) as never,
    );

    const report = await verifyContacts(prisma, rows, {
      sampleSize: 20,
      pickSample: (all, n) => all.slice(0, n) as ParsedContactLine[],
    });

    expect(report.sampleSize).toBe(2);
  });
});
