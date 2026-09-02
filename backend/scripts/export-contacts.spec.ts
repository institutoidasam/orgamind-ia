import { describe, it, expect } from 'vitest';
import { mockDeep } from 'vitest-mock-extended';
import type { PrismaService } from '../src/shared/prisma/prisma.service';
import {
  exportContacts,
  serializeContactLine,
  CONTACT_EXPORT_SELECT,
  type ContactExportDbRow,
} from './export-contacts';

function row(overrides: Partial<ContactExportDbRow> = {}): ContactExportDbRow {
  return {
    id: 'c1',
    phoneE164: '+5592900000001',
    name: 'Maria',
    city: 'Manaus',
    group: 'alunos',
    tags: ['vip'],
    customFields: { origem: 'planilha' },
    optedOut: false,
    whatsappValid: true,
    whatsappCheckedAt: new Date('2026-01-01T00:00:00.000Z'),
    profilePictureUrl: null,
    waLabels: ['cliente'],
    createdAt: new Date('2025-12-01T00:00:00.000Z'),
    updatedAt: new Date('2025-12-02T00:00:00.000Z'),
    ...overrides,
  };
}

describe('serializeContactLine', () => {
  it('serializes dates as ISO 8601 strings and appends a trailing newline', () => {
    const line = serializeContactLine(row());
    expect(line.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(line.trim());
    expect(parsed.whatsappCheckedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(parsed.createdAt).toBe('2025-12-01T00:00:00.000Z');
    expect(parsed.updatedAt).toBe('2025-12-02T00:00:00.000Z');
    expect(parsed.phoneE164).toBe('+5592900000001');
    expect(parsed.tags).toEqual(['vip']);
    expect(parsed.customFields).toEqual({ origem: 'planilha' });
  });

  it('serializes a null whatsappCheckedAt as null', () => {
    const line = serializeContactLine(row({ whatsappCheckedAt: null }));
    expect(JSON.parse(line.trim()).whatsappCheckedAt).toBeNull();
  });
});

describe('exportContacts', () => {
  it('paginates by cursor until an empty page, selecting the full Contact shape', async () => {
    const prisma = mockDeep<PrismaService>();
    const page1 = [row({ id: 'c1' }), row({ id: 'c2', phoneE164: '+5592900000002' })];
    const page2 = [row({ id: 'c3', phoneE164: '+5592900000003' })];
    prisma.contact.findMany
      .mockResolvedValueOnce(page1 as never)
      .mockResolvedValueOnce(page2 as never)
      .mockResolvedValueOnce([] as never);

    const written: string[] = [];
    const total = await exportContacts(prisma, { batchSize: 2, write: (l) => written.push(l) });

    expect(total).toBe(3);
    expect(written).toHaveLength(3);
    expect(prisma.contact.findMany).toHaveBeenCalledTimes(3);

    expect(prisma.contact.findMany).toHaveBeenNthCalledWith(1, {
      take: 2,
      orderBy: { id: 'asc' },
      select: CONTACT_EXPORT_SELECT,
    });
    expect(prisma.contact.findMany).toHaveBeenNthCalledWith(2, {
      take: 2,
      skip: 1,
      cursor: { id: 'c2' },
      orderBy: { id: 'asc' },
      select: CONTACT_EXPORT_SELECT,
    });
    expect(prisma.contact.findMany).toHaveBeenNthCalledWith(3, {
      take: 2,
      skip: 1,
      cursor: { id: 'c3' },
      orderBy: { id: 'asc' },
      select: CONTACT_EXPORT_SELECT,
    });
  });

  it('writes valid JSONL lines and reports progress via onBatch', async () => {
    const prisma = mockDeep<PrismaService>();
    prisma.contact.findMany
      .mockResolvedValueOnce([row({ id: 'c1' })] as never)
      .mockResolvedValueOnce([] as never);

    const progress: number[] = [];
    const written: string[] = [];
    await exportContacts(prisma, {
      batchSize: 100,
      write: (l) => written.push(l),
      onBatch: (n) => progress.push(n),
    });

    expect(progress).toEqual([1]);
    expect(written).toHaveLength(1);
    expect(() => JSON.parse(written[0])).not.toThrow();
  });

  it('returns 0 and writes nothing when there are no contacts', async () => {
    const prisma = mockDeep<PrismaService>();
    prisma.contact.findMany.mockResolvedValueOnce([] as never);

    const written: string[] = [];
    const total = await exportContacts(prisma, { write: (l) => written.push(l) });

    expect(total).toBe(0);
    expect(written).toHaveLength(0);
  });
});
