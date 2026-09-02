import { describe, it, expect, vi } from 'vitest';
import { mockDeep } from 'vitest-mock-extended';
import { ConsentAction, ConsentSource } from '@prisma/client';
import type { PrismaService } from '../src/shared/prisma/prisma.service';
import type { ConsentService } from '../src/modules/consent/consent.service';
import {
  findMisclassifiedSuppressions,
  repairMisclassifiedSuppressions,
  MISCLASSIFIED_OPT_OUT_CODES,
} from './repair-provider-optout-misclassification';

function mkPrisma() {
  return mockDeep<PrismaService>();
}

describe('MISCLASSIFIED_OPT_OUT_CODES', () => {
  it('is exactly the two codes wrongly treated as opt-out (131026, 131047)', () => {
    expect([...MISCLASSIFIED_OPT_OUT_CODES].sort()).toEqual(['131026', '131047']);
  });
});

describe('findMisclassifiedSuppressions', () => {
  it('finds a contact CURRENTLY suppressed by a 131026 PROVIDER_OPTOUT revoke', async () => {
    const prisma = mkPrisma();
    prisma.suppressionList.findMany.mockResolvedValue([
      { phoneHash: 'h1', phoneE164: '+5592900000001', lastEventId: 'ev1' } as never,
    ]);
    prisma.consentEvent.findMany.mockResolvedValue([
      {
        id: 'ev1',
        contactId: 'c1',
        purposeKey: '*',
        action: ConsentAction.REVOKE,
        source: ConsentSource.PROVIDER_OPTOUT,
        evidence: { errorCode: '131026', providerMessageId: 'wamid.1' },
      } as never,
    ]);

    const candidates = await findMisclassifiedSuppressions(prisma);

    expect(candidates).toEqual([
      {
        contactId: 'c1',
        phoneHash: 'h1',
        phoneE164: '+5592900000001',
        wrongEventId: 'ev1',
        errorCode: '131026',
      },
    ]);
  });

  it('finds a contact CURRENTLY suppressed by a 131047 PROVIDER_OPTOUT revoke', async () => {
    const prisma = mkPrisma();
    prisma.suppressionList.findMany.mockResolvedValue([
      { phoneHash: 'h2', phoneE164: '+5592900000002', lastEventId: 'ev2' } as never,
    ]);
    prisma.consentEvent.findMany.mockResolvedValue([
      {
        id: 'ev2',
        contactId: 'c2',
        purposeKey: '*',
        action: ConsentAction.REVOKE,
        source: ConsentSource.PROVIDER_OPTOUT,
        evidence: { errorCode: '131047', providerMessageId: 'wamid.2' },
      } as never,
    ]);

    const candidates = await findMisclassifiedSuppressions(prisma);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ contactId: 'c2', errorCode: '131047' });
  });

  it('does NOT include a contact suppressed by a REAL opt-out code (131050)', async () => {
    const prisma = mkPrisma();
    prisma.suppressionList.findMany.mockResolvedValue([
      { phoneHash: 'h3', phoneE164: '+5592900000003', lastEventId: 'ev3' } as never,
    ]);
    prisma.consentEvent.findMany.mockResolvedValue([
      {
        id: 'ev3',
        contactId: 'c3',
        purposeKey: '*',
        action: ConsentAction.REVOKE,
        source: ConsentSource.PROVIDER_OPTOUT,
        evidence: { errorCode: '131050', providerMessageId: 'wamid.3' },
      } as never,
    ]);

    const candidates = await findMisclassifiedSuppressions(prisma);

    expect(candidates).toEqual([]);
  });

  it('does NOT include a contact suppressed by a real STOP keyword (WA_KEYWORD source)', async () => {
    const prisma = mkPrisma();
    prisma.suppressionList.findMany.mockResolvedValue([
      { phoneHash: 'h4', phoneE164: '+5592900000004', lastEventId: 'ev4' } as never,
    ]);
    // The event exists but its source is WA_KEYWORD, not PROVIDER_OPTOUT — the
    // query for PROVIDER_OPTOUT events won't even return it.
    prisma.consentEvent.findMany.mockResolvedValue([]);

    const candidates = await findMisclassifiedSuppressions(prisma);

    expect(candidates).toEqual([]);
  });

  it('does NOT include a contact whose suppression was already superseded by a LATER event (safety: only touch the CURRENT cause)', async () => {
    const prisma = mkPrisma();
    // lastEventId now points at a later, legitimate revoke (ev5-new) — the
    // original wrongful 131026 event (ev5-old) is no longer the operative one.
    prisma.suppressionList.findMany.mockResolvedValue([
      { phoneHash: 'h5', phoneE164: '+5592900000005', lastEventId: 'ev5-new' } as never,
    ]);
    prisma.consentEvent.findMany.mockResolvedValue([
      {
        id: 'ev5-new',
        contactId: 'c5',
        purposeKey: '*',
        action: ConsentAction.REVOKE,
        source: ConsentSource.WA_KEYWORD,
        evidence: null,
      } as never,
    ]);

    const candidates = await findMisclassifiedSuppressions(prisma);

    expect(candidates).toEqual([]);
  });

  it('does NOT include a contact who already came back (no longer in SuppressionList)', async () => {
    const prisma = mkPrisma();
    prisma.suppressionList.findMany.mockResolvedValue([]);

    const candidates = await findMisclassifiedSuppressions(prisma);

    expect(candidates).toEqual([]);
    // Never even queries consentEvent when there is nothing suppressed.
    expect(prisma.consentEvent.findMany).not.toHaveBeenCalled();
  });

  it('returns empty without querying consentEvent when nothing is suppressed', async () => {
    const prisma = mkPrisma();
    prisma.suppressionList.findMany.mockResolvedValue([]);
    const candidates = await findMisclassifiedSuppressions(prisma);
    expect(candidates).toEqual([]);
  });
});

describe('repairMisclassifiedSuppressions', () => {
  it('reverses a candidate whose Contact still exists via ConsentService.reinstate, sourced as SYSTEM_REPAIR', async () => {
    const prisma = mkPrisma();
    prisma.contact.findUnique.mockResolvedValue({
      id: 'c1',
      phoneE164: '+5592900000001',
    } as never);
    const consent: Pick<ConsentService, 'reinstate'> = {
      reinstate: vi.fn().mockResolvedValue(['servico_projeto']),
    };

    const report = await repairMisclassifiedSuppressions(prisma, consent as ConsentService, [
      {
        contactId: 'c1',
        phoneHash: 'h1',
        phoneE164: '+5592900000001',
        wrongEventId: 'ev1',
        errorCode: '131026',
      },
    ]);

    expect(consent.reinstate).toHaveBeenCalledWith(
      expect.objectContaining({
        contactId: 'c1',
        phoneE164: '+5592900000001',
        source: ConsentSource.SYSTEM_REPAIR,
        evidenceText: expect.stringContaining('131026'),
        evidence: expect.objectContaining({ repairOf: 'ev1', errorCode: '131026' }),
      }),
    );
    expect(report.repaired).toHaveLength(1);
    expect(report.skippedMissingContact).toEqual([]);
  });

  it('skips (does not call reinstate) a candidate whose Contact no longer exists, and reports it', async () => {
    const prisma = mkPrisma();
    prisma.contact.findUnique.mockResolvedValue(null);
    const consent: Pick<ConsentService, 'reinstate'> = {
      reinstate: vi.fn(),
    };

    const report = await repairMisclassifiedSuppressions(prisma, consent as ConsentService, [
      {
        contactId: 'c-deleted',
        phoneHash: 'h9',
        phoneE164: '+5592900000009',
        wrongEventId: 'ev9',
        errorCode: '131047',
      },
    ]);

    expect(consent.reinstate).not.toHaveBeenCalled();
    expect(report.repaired).toEqual([]);
    expect(report.skippedMissingContact).toHaveLength(1);
    expect(report.skippedMissingContact[0]).toMatchObject({ contactId: 'c-deleted' });
  });

  it('processes a mix of repairable and missing-contact candidates independently', async () => {
    const prisma = mkPrisma();
    prisma.contact.findUnique.mockImplementation(((args: { where: { id: string } }) =>
      Promise.resolve(
        args.where.id === 'c-ok' ? ({ id: 'c-ok', phoneE164: '+5592900000010' } as never) : null,
      )) as never);
    const consent: Pick<ConsentService, 'reinstate'> = {
      reinstate: vi.fn().mockResolvedValue([]),
    };

    const report = await repairMisclassifiedSuppressions(prisma, consent as ConsentService, [
      { contactId: 'c-ok', phoneHash: 'hA', phoneE164: '+5592900000010', wrongEventId: 'evA', errorCode: '131026' },
      { contactId: 'c-gone', phoneHash: 'hB', phoneE164: '+5592900000011', wrongEventId: 'evB', errorCode: '131047' },
    ]);

    expect(consent.reinstate).toHaveBeenCalledTimes(1);
    expect(report.repaired.map((c) => c.contactId)).toEqual(['c-ok']);
    expect(report.skippedMissingContact.map((c) => c.contactId)).toEqual(['c-gone']);
  });
});
