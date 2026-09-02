import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockDeep, type MockProxy } from 'vitest-mock-extended';
import { ConsentAction, ConsentSource } from '@prisma/client';
import { ConsentBulkGrantService } from './consent-bulk-grant.service';
import { ConsentService } from './consent.service';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { AuditService } from '../../shared/audit/audit.service';
import {
  PurposeInactiveError,
  PurposeNotFoundError,
} from './errors/consent.errors';
import type { BulkGrant } from '../../schemas/contracts/consent-admin.schema';

const COLLECTED_AT = new Date('2025-03-12T00:00:00.000Z');

const INPUT: BulkGrant = {
  purposeKey: 'continuum_avisos',
  filters: { combinator: 'and', rules: [{ field: 'group', op: 'eq', value: 'CONTINUUM' }] },
  evidenceRef: 'Contrato CONTINUUM #123',
  collectedAt: COLLECTED_AT,
  evidenceNote: 'Cláusula 7 do contrato assinado.',
};

const ACTOR = { id: 'user-1', email: 'admin@continuum.com' };

const CONTACTS = [
  { id: 'c1', phoneE164: '+5592991110001' },
  { id: 'c2', phoneE164: '+5592991110002' },
  { id: 'c3', phoneE164: '+5592991110003' },
];

describe('ConsentBulkGrantService.apply', () => {
  let prisma: MockProxy<PrismaService>;
  let consent: MockProxy<ConsentService>;
  let audit: MockProxy<AuditService>;
  let svc: ConsentBulkGrantService;

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    consent = mockDeep<ConsentService>();
    audit = mockDeep<AuditService>();

    prisma.consentPurpose.findUnique.mockResolvedValue({
      key: 'continuum_avisos',
      label: 'Avisos do CONTINUUM',
      active: true,
    } as never);
    prisma.consentText.findFirst.mockResolvedValue({
      version: 'optin-continuum-v1',
    } as never);
    prisma.contact.findMany.mockResolvedValue(CONTACTS as never);

    consent.suppressedPhones.mockResolvedValue(new Set());
    consent.grantedContactIds.mockResolvedValue(new Set());
    consent.record.mockResolvedValue({ eventId: 'e1', created: true });

    svc = new ConsentBulkGrantService(prisma, consent, audit);
  });

  it('concede a finalidade a toda a audiência, com a evidência e a DATA DA COLETA', async () => {
    const res = await svc.apply(INPUT, ACTOR);

    expect(res).toEqual({
      total: 3,
      granted: 3,
      skippedSuppressed: 0,
      alreadyGranted: 0,
      failed: 0,
    });
    expect(consent.record).toHaveBeenCalledTimes(3);

    const call = consent.record.mock.calls[0][0];
    expect(call).toMatchObject({
      contactId: 'c1',
      phoneE164: '+5592991110001',
      purposeKey: 'continuum_avisos',
      action: ConsentAction.GRANT,
      // A base legada é o backfill auditado da coorte C2 da spec (§6.2), e o
      // enum já tem a fonte para isso.
      source: ConsentSource.IMPORT_LEGACY,
      // `occurredAt` é QUANDO A PESSOA CONCORDOU, não agora: um consentimento de
      // março é um consentimento de março, e o painel precisa mostrar isso.
      occurredAt: COLLECTED_AT,
      actorUserId: 'user-1',
      consentTextVersion: 'optin-continuum-v1',
    });
  });

  it('o evidenceText compõe referência + observação + operador + data', async () => {
    await svc.apply(INPUT, ACTOR);

    const { evidenceText } = consent.record.mock.calls[0][0];
    expect(evidenceText).toContain('Contrato CONTINUUM #123');
    expect(evidenceText).toContain('Cláusula 7 do contrato assinado.');
    expect(evidenceText).toContain('admin@continuum.com');
    expect(evidenceText).toContain('12/03/2025');
    // O registro precisa dizer o que ele É: consentimento colhido FORA do
    // WhatsApp e declarado por um operador — não um ato do titular no orgamind.
    expect(evidenceText).toMatch(/base legal pré-existente|fora do WhatsApp/i);
  });

  it('guarda a evidência estruturada no JSON do evento', async () => {
    await svc.apply(INPUT, ACTOR);

    const { evidence } = consent.record.mock.calls[0][0];
    expect(evidence).toMatchObject({
      evidenceRef: 'Contrato CONTINUUM #123',
      evidenceNote: 'Cláusula 7 do contrato assinado.',
      actorUserId: 'user-1',
      actorEmail: 'admin@continuum.com',
    });
  });

  it('NUNCA concede a quem está na SuppressionList — e conta separado', async () => {
    consent.suppressedPhones.mockResolvedValue(new Set(['+5592991110002']));

    const res = await svc.apply(INPUT, ACTOR);

    expect(res).toEqual({
      total: 3,
      granted: 2,
      skippedSuppressed: 1,
      alreadyGranted: 0,
      failed: 0,
    });
    const phones = consent.record.mock.calls.map((c) => c[0].phoneE164);
    expect(phones).not.toContain('+5592991110002');
    // Revogação é ABSOLUTA (art. 8º §5º): nem um contrato, nem um ADMIN, nem uma
    // declaração de base legal a fura.
    expect(phones).toEqual(['+5592991110001', '+5592991110003']);
  });

  it('exclui optedOut=true do conjunto que recebe GRANT — mesmo fora da SuppressionList (RED: hoje o where não filtra optedOut)', async () => {
    await svc.apply(INPUT, ACTOR);

    // O `toPrismaWhere` compartilhado deixou de embutir `{ optedOut: false }`
    // no público de campanha (decisão do cliente, 25/08 — filter.converter.ts).
    // Bulk-grant é o sentido CONTRÁRIO do disparo: ele CONCEDE consentimento,
    // então alcançar quem pediu para sair é pior do que só enviar para ele — a
    // proteção precisa ser restaurada AQUI, no próprio serviço. Mocks de
    // Prisma ignoram `where` (sempre devolvem `CONTACTS`), então a prova é o
    // ARGUMENTO da chamada, não o resultado.
    expect(prisma.contact.findMany).toHaveBeenCalledWith({
      where: {
        AND: [{ AND: [{ group: 'CONTINUUM' }] }, { optedOut: false }],
      },
      select: { id: true, phoneE164: true },
    });
  });

  it('é idempotente: rodar 2x não duplica GRANT ativo', async () => {
    consent.grantedContactIds.mockResolvedValue(new Set(['c1', 'c2', 'c3']));

    const res = await svc.apply(INPUT, ACTOR);

    expect(res).toEqual({
      total: 3,
      granted: 0,
      skippedSuppressed: 0,
      alreadyGranted: 3,
      failed: 0,
    });
    expect(consent.record).not.toHaveBeenCalled();
  });

  it('as contagens sempre fecham com o total da audiência', async () => {
    consent.suppressedPhones.mockResolvedValue(new Set(['+5592991110001']));
    consent.grantedContactIds.mockResolvedValue(new Set(['c2']));

    const res = await svc.apply(INPUT, ACTOR);

    expect(res.granted + res.skippedSuppressed + res.alreadyGranted).toBe(
      res.total,
    );
    expect(res).toEqual({
      total: 3,
      granted: 1,
      skippedSuppressed: 1,
      alreadyGranted: 1,
      failed: 0,
    });
  });

  it('audita o operador, a finalidade, o total e a evidência', async () => {
    await svc.apply(INPUT, ACTOR);

    expect(audit.log).toHaveBeenCalledWith(
      'consent.bulk_grant',
      'ConsentPurpose',
      'continuum_avisos',
      expect.objectContaining({
        actorUserId: 'user-1',
        actorEmail: 'admin@continuum.com',
        purposeKey: 'continuum_avisos',
        total: 3,
        granted: 3,
        evidenceRef: 'Contrato CONTINUUM #123',
        collectedAt: COLLECTED_AT.toISOString(),
      }),
    );
  });

  it('recusa finalidade inexistente', async () => {
    prisma.consentPurpose.findUnique.mockResolvedValue(null as never);

    await expect(svc.apply(INPUT, ACTOR)).rejects.toBeInstanceOf(
      PurposeNotFoundError,
    );
    expect(consent.record).not.toHaveBeenCalled();
  });

  it('recusa finalidade desativada — registrar nela é criar prova morta', async () => {
    prisma.consentPurpose.findUnique.mockResolvedValue({
      key: 'continuum_avisos',
      label: 'Avisos do CONTINUUM',
      active: false,
    } as never);

    await expect(svc.apply(INPUT, ACTOR)).rejects.toBeInstanceOf(
      PurposeInactiveError,
    );
    expect(consent.record).not.toHaveBeenCalled();
  });

  it('audiência vazia devolve zeros e não grava nada', async () => {
    prisma.contact.findMany.mockResolvedValue([] as never);

    const res = await svc.apply(INPUT, ACTOR);

    expect(res).toEqual({
      total: 0,
      granted: 0,
      skippedSuppressed: 0,
      alreadyGranted: 0,
      failed: 0,
    });
    expect(consent.record).not.toHaveBeenCalled();
  });

  /**
   * F1 T4 — o choke point: um filtro history+templateIds tem de virar
   * campaignIds ANTES do toPrismaWhere, ou o `contact.findMany` roda com um
   * `where` que nunca casa nada (campaignId nunca é o templateId).
   */
  it('resolve history+templateIds para campaignIds antes de montar o where da audiência (F1 T4)', async () => {
    const input: BulkGrant = {
      ...INPUT,
      filters: {
        combinator: 'and',
        rules: [
          {
            kind: 'history',
            event: 'received',
            negate: false,
            templateIds: ['tpl1'],
          },
        ],
      },
    };
    prisma.campaign.findMany.mockResolvedValue([
      { id: 'campA', templateId: 'tpl1' },
    ] as never);

    await svc.apply(input, ACTOR);

    expect(prisma.campaign.findMany).toHaveBeenCalledWith({
      where: { templateId: { in: ['tpl1'] } },
      select: { id: true, templateId: true },
    });
    // 2026-08-25 — decisão do cliente: `toPrismaWhere` não embute mais
    // `{ optedOut: false }` no público de CAMPANHA (ver filter.converter.ts).
    // Bulk-grant não é o público de campanha: é o sentido contrário (CONCEDE
    // consentimento), então a exclusão de opt-out foi restaurada LOCALMENTE,
    // logo abaixo de `toPrismaWhere` neste serviço (consent-bulk-grant.service.ts)
    // — não é mais herdada do conversor compartilhado. A proteção contra quem
    // está na SuppressionList continua separada — via `consent.suppressedPhones()`,
    // verificado no teste "NUNCA concede a quem está na SuppressionList" acima.
    expect(prisma.contact.findMany).toHaveBeenCalledWith({
      where: {
        AND: [
          {
            AND: [
              {
                messages: {
                  some: {
                    campaignId: { in: ['campA'] },
                    direction: 'OUTBOUND',
                    status: { in: ['SENT', 'DELIVERED', 'READ'] },
                  },
                },
              },
            ],
          },
          { optedOut: false },
        ],
      },
      select: { id: true, phoneE164: true },
    });
  });
});

describe('ConsentBulkGrantService.preview', () => {
  let prisma: MockProxy<PrismaService>;
  let consent: MockProxy<ConsentService>;
  let audit: MockProxy<AuditService>;
  let svc: ConsentBulkGrantService;

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    consent = mockDeep<ConsentService>();
    audit = mockDeep<AuditService>();
    prisma.consentPurpose.findUnique.mockResolvedValue({
      key: 'continuum_avisos',
      label: 'Avisos do CONTINUUM',
      active: true,
    } as never);
    prisma.consentText.findFirst.mockResolvedValue(null as never);
    prisma.contact.findMany.mockResolvedValue(CONTACTS as never);
    consent.suppressedPhones.mockResolvedValue(new Set(['+5592991110003']));
    consent.grantedContactIds.mockResolvedValue(new Set(['c1']));
    svc = new ConsentBulkGrantService(prisma, consent, audit);
  });

  it('conta quantos serão afetados SEM gravar nada', async () => {
    const res = await svc.preview(INPUT);

    expect(res).toEqual({
      total: 3,
      granted: 1,
      skippedSuppressed: 1,
      alreadyGranted: 1,
      failed: 0,
    });
    // O número que o operador vê antes de confirmar é o mesmo que o apply usa.
    expect(consent.record).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });
});

describe('ConsentBulkGrantService — lotes grandes', () => {
  it('processa a base inteira (13k) sem estourar o IN da consulta', async () => {
    const prisma = mockDeep<PrismaService>();
    const consent = mockDeep<ConsentService>();
    const audit = mockDeep<AuditService>();

    const many = Array.from({ length: 4_500 }, (_, i) => ({
      id: `c${i}`,
      phoneE164: `+55929911${String(i).padStart(5, '0')}`,
    }));
    prisma.consentPurpose.findUnique.mockResolvedValue({
      key: 'continuum_avisos',
      label: 'Avisos',
      active: true,
    } as never);
    prisma.consentText.findFirst.mockResolvedValue(null as never);
    prisma.contact.findMany.mockResolvedValue(many as never);
    consent.suppressedPhones.mockResolvedValue(new Set());
    consent.grantedContactIds.mockResolvedValue(new Set());
    consent.record.mockResolvedValue({ eventId: 'e', created: true });

    const svc = new ConsentBulkGrantService(prisma, consent, audit);
    const res = await svc.apply(INPUT, ACTOR);

    expect(res.total).toBe(4_500);
    expect(res.granted).toBe(4_500);
    // grantedContactIds é chamado em lotes (nunca um IN de 13k ids de uma vez).
    expect(consent.grantedContactIds.mock.calls.length).toBeGreaterThan(1);
    for (const [ids] of consent.grantedContactIds.mock.calls) {
      expect(ids.length).toBeLessThanOrEqual(2_000);
    }
  });
});

describe('ConsentBulkGrantService — falha parcial', () => {
  it('um contato que falha não derruba o lote inteiro', async () => {
    const prisma = mockDeep<PrismaService>();
    const consent = mockDeep<ConsentService>();
    const audit = mockDeep<AuditService>();

    prisma.consentPurpose.findUnique.mockResolvedValue({
      key: 'continuum_avisos',
      label: 'Avisos',
      active: true,
    } as never);
    prisma.consentText.findFirst.mockResolvedValue(null as never);
    prisma.contact.findMany.mockResolvedValue(CONTACTS as never);
    consent.suppressedPhones.mockResolvedValue(new Set());
    consent.grantedContactIds.mockResolvedValue(new Set());
    consent.record.mockImplementation(async (input) => {
      if (input.contactId === 'c2') throw new Error('deadlock');
      return { eventId: 'e', created: true };
    });

    const svc = new ConsentBulkGrantService(prisma, consent, audit);
    const res = await svc.apply(INPUT, ACTOR);

    expect(res.granted).toBe(2);
    expect(res.failed).toBe(1);
  });
});
