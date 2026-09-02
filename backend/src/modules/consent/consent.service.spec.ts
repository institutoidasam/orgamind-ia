import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockDeep, type MockProxy } from 'vitest-mock-extended';
import type { ConfigService } from '@nestjs/config';
import { ConsentAction, ConsentSource, ConsentState } from '@prisma/client';
import { ConsentService, GLOBAL_PURPOSE } from './consent.service';
import { PrismaService } from '../../shared/prisma/prisma.service';
import type { Env } from '../../shared/config/env.schema';
import { phoneHash } from './phone-hash.util';

const SALT = 'test-salt';
/** Móvel moderno (9 dígitos, começa com 9) → tem forma legada de 8 dígitos. */
const PHONE = '+5592998887777';
const PHONE_LEGACY = '+559298887777';

/**
 * In-memory stand-in for the three consent tables. The precedence rule (spec
 * §2.7) is the whole point of ConsentService, and it is a rule ABOUT the event
 * history — mocking `findFirst` per call would only assert the calls we already
 * wrote. This fake stores events and lets the real recompute run against them.
 */
function makeFakeDb() {
  const events: any[] = [];
  const contactConsents = new Map<string, any>();
  const suppression = new Map<string, any>();
  const contacts = new Map<string, any>([
    ['c1', { id: 'c1', phoneE164: PHONE, optInAt: null, optInSource: null, optedOut: false }],
  ]);

  const cmp = (a: any, b: any) => {
    // ordem: occurredAt desc, recordedAt desc; empate total → REVOKE vence.
    const t = b.occurredAt.getTime() - a.occurredAt.getTime();
    if (t !== 0) return t;
    const r = b.recordedAt.getTime() - a.recordedAt.getTime();
    if (r !== 0) return r;
    if (a.action === b.action) return 0;
    return a.action === ConsentAction.REVOKE ? -1 : 1;
  };

  const matches = (e: any, where: any): boolean => {
    if (where.AND) return where.AND.every((w: any) => matches(e, w));
    for (const [k, v] of Object.entries(where)) {
      if (k === 'AND') continue;
      const actual = (e as any)[k];
      if (v && typeof v === 'object' && 'in' in (v as any)) {
        if (!(v as any).in.includes(actual)) return false;
      } else if (v && typeof v === 'object' && 'gte' in (v as any)) {
        if (!(actual >= (v as any).gte)) return false;
      } else if (actual !== v) return false;
    }
    return true;
  };

  const prisma = mockDeep<PrismaService>();

  prisma.consentEvent.create.mockImplementation((async ({ data }: any) => {
    const row = {
      ...data,
      id: data.id ?? `ev${events.length + 1}`,
      recordedAt: data.recordedAt ?? new Date(),
    };
    events.push(row);
    return row;
  }) as never);

  prisma.consentEvent.findFirst.mockImplementation((async ({ where }: any) => {
    const found = events.filter((e) => matches(e, where)).sort(cmp);
    return found[0] ?? null;
  }) as never);

  prisma.consentEvent.findMany.mockImplementation((async ({ where }: any) => {
    return events.filter((e) => matches(e, where)).sort(cmp);
  }) as never);

  prisma.contactConsent.upsert.mockImplementation((async ({ where, create, update }: any) => {
    const key = `${where.contactId_purposeKey.contactId}:${where.contactId_purposeKey.purposeKey}`;
    const prev = contactConsents.get(key);
    const row = prev ? { ...prev, ...update } : { ...where.contactId_purposeKey, ...create };
    contactConsents.set(key, row);
    return row;
  }) as never);

  prisma.contactConsent.findUnique.mockImplementation((async ({ where }: any) => {
    return (
      contactConsents.get(
        `${where.contactId_purposeKey.contactId}:${where.contactId_purposeKey.purposeKey}`,
      ) ?? null
    );
  }) as never);

  prisma.contactConsent.findMany.mockImplementation((async ({ where, orderBy, take }: any) => {
    let rows = [...contactConsents.values()].filter((r) => {
      if (where.contactId && r.contactId !== where.contactId) return false;
      if (where.state && r.state !== where.state) return false;
      if (where.lastEventId && r.lastEventId !== where.lastEventId) return false;
      return true;
    });
    // O cache Contact.optInAt depende de `orderBy: { grantedAt: 'desc' }, take: 1`
    // — um fake que devolvesse a ordem de inserção passaria o teste por acidente.
    if (orderBy?.grantedAt === 'desc') {
      rows = rows.sort(
        (a, b) => (b.grantedAt?.getTime() ?? 0) - (a.grantedAt?.getTime() ?? 0),
      );
    }
    return take ? rows.slice(0, take) : rows;
  }) as never);

  prisma.contactConsent.updateMany.mockImplementation((async ({ where, data }: any) => {
    let count = 0;
    for (const [k, r] of contactConsents) {
      if (where.contactId && r.contactId !== where.contactId) continue;
      if (where.state && r.state !== where.state) continue;
      contactConsents.set(k, { ...r, ...data });
      count += 1;
    }
    return { count };
  }) as never);

  prisma.suppressionList.upsert.mockImplementation((async ({ where, create, update }: any) => {
    const prev = suppression.get(where.phoneHash);
    const row = prev
      ? { ...prev, ...update }
      : { ...create, suppressedAt: create.suppressedAt ?? new Date() };
    suppression.set(where.phoneHash, row);
    return row;
  }) as never);

  prisma.suppressionList.findFirst.mockImplementation((async ({ where }: any) => {
    const hashes: string[] = where.phoneHash?.in ?? [where.phoneHash];
    for (const h of hashes) if (suppression.has(h)) return suppression.get(h);
    return null;
  }) as never);

  prisma.suppressionList.findMany.mockImplementation((async ({ where }: any) => {
    const hashes: string[] = where.phoneHash?.in ?? [];
    return hashes.filter((h) => suppression.has(h)).map((h) => ({ phoneHash: h }));
  }) as never);

  prisma.suppressionList.deleteMany.mockImplementation((async ({ where }: any) => {
    const hashes: string[] = where.phoneHash?.in ?? [where.phoneHash];
    let count = 0;
    for (const h of hashes) if (suppression.delete(h)) count += 1;
    return { count };
  }) as never);

  prisma.contact.update.mockImplementation((async ({ where, data }: any) => {
    const row = { ...contacts.get(where.id), ...data };
    contacts.set(where.id, row);
    return row;
  }) as never);

  prisma.contact.findFirst.mockImplementation((async () => contacts.get('c1') ?? null) as never);

  // $transaction(fn) runs the callback against the same fake client.
  (prisma.$transaction as any).mockImplementation(async (fn: any) =>
    typeof fn === 'function' ? fn(prisma) : Promise.all(fn),
  );

  return { prisma, events, contactConsents, suppression, contacts };
}

describe('ConsentService', () => {
  let db: ReturnType<typeof makeFakeDb>;
  let config: MockProxy<ConfigService<Env>>;
  let service: ConsentService;

  const grant = (purposeKey: string, occurredAt: Date, source = ConsentSource.WEB_FORM) =>
    service.record({
      contactId: 'c1',
      phoneE164: PHONE,
      purposeKey,
      action: ConsentAction.GRANT,
      source,
      evidenceText: 'Autorizo o IDASAM a me enviar mensagens no WhatsApp sobre X.',
      occurredAt,
    });

  const revoke = (purposeKey: string, occurredAt: Date, source = ConsentSource.WA_KEYWORD) =>
    service.record({
      contactId: 'c1',
      phoneE164: PHONE,
      purposeKey,
      action: ConsentAction.REVOKE,
      source,
      evidenceText: 'PARAR',
      occurredAt,
      suppressionReason: 'keyword_parar',
    });

  beforeEach(() => {
    db = makeFakeDb();
    config = mockDeep<ConfigService<Env>>();
    config.get.mockImplementation(((key: string) =>
      key === 'PICOA_CONSENT_SALT' ? SALT : undefined) as never);
    service = new ConsentService(db.prisma, config);
  });

  describe('record() — trilha append-only', () => {
    it('grava um ConsentEvent com phoneHash durável e o texto exibido por valor', async () => {
      await grant('convite_atividades', new Date('2026-07-01T10:00:00Z'));

      expect(db.events).toHaveLength(1);
      expect(db.events[0]).toMatchObject({
        contactId: 'c1',
        phoneHash: phoneHash(PHONE, SALT),
        purposeKey: 'convite_atividades',
        action: ConsentAction.GRANT,
        source: ConsentSource.WEB_FORM,
        evidenceText: 'Autorizo o IDASAM a me enviar mensagens no WhatsApp sobre X.',
      });
    });

    it('recusa um GRANT sem evidenceText — nunca existe consentimento sem o texto exibido', async () => {
      await expect(
        service.record({
          contactId: 'c1',
          phoneE164: PHONE,
          purposeKey: 'convite_atividades',
          action: ConsentAction.GRANT,
          source: ConsentSource.WEB_FORM,
          evidenceText: '   ',
        }),
      ).rejects.toThrow(/evidenceText/i);
      expect(db.events).toHaveLength(0);
    });
  });

  describe('precedência GRANT/REVOKE (spec §2.7)', () => {
    it('GRANT → REVOKE → GRANT: o evento mais recente por occurredAt vence', async () => {
      await grant('convite_atividades', new Date('2026-07-01T10:00:00Z'));
      expect(await service.hasConsent('c1', 'convite_atividades')).toBe(true);

      await revoke('convite_atividades', new Date('2026-07-02T10:00:00Z'));
      expect(await service.hasConsent('c1', 'convite_atividades')).toBe(false);

      await grant('convite_atividades', new Date('2026-07-03T10:00:00Z'));
      expect(await service.hasConsent('c1', 'convite_atividades')).toBe(true);

      // A trilha inteira sobrevive — é ela que prova a licitude de cada disparo.
      expect(db.events).toHaveLength(3);
    });

    it('empate em occurredAt e recordedAt → REVOKE vence (fail-safe: na dúvida não envia)', async () => {
      const t = new Date('2026-07-01T10:00:00Z');
      vi.setSystemTime(t);
      await grant('convite_atividades', t);
      await revoke('convite_atividades', t);
      vi.useRealTimers();

      expect(await service.hasConsent('c1', 'convite_atividades')).toBe(false);
    });

    it('REVOKE global (purposeKey=*) revoga TODAS as finalidades e suprime o telefone', async () => {
      await grant('convite_atividades', new Date('2026-07-01T10:00:00Z'));
      await grant('captacao_recursos', new Date('2026-07-01T10:00:00Z'));

      await revoke(GLOBAL_PURPOSE, new Date('2026-07-02T10:00:00Z'));

      expect(await service.hasConsent('c1', 'convite_atividades')).toBe(false);
      expect(await service.hasConsent('c1', 'captacao_recursos')).toBe(false);
      expect(await service.isSuppressed(PHONE)).toBe(true);
    });

    it('GRANT posterior a um REVOKE global só reabre a finalidade que ele declara, e levanta a supressão', async () => {
      await grant('convite_atividades', new Date('2026-07-01T10:00:00Z'));
      await grant('captacao_recursos', new Date('2026-07-01T10:00:00Z'));
      await revoke(GLOBAL_PURPOSE, new Date('2026-07-02T10:00:00Z'));

      await grant('convite_atividades', new Date('2026-07-03T10:00:00Z'));

      expect(await service.hasConsent('c1', 'convite_atividades')).toBe(true);
      // captacao_recursos NÃO volta sozinha — o GRANT não a declarou.
      expect(await service.hasConsent('c1', 'captacao_recursos')).toBe(false);
      expect(await service.isSuppressed(PHONE)).toBe(false);
    });

    it('consentir para uma finalidade não autoriza outra (art. 8º §4º)', async () => {
      await grant('convite_atividades', new Date('2026-07-01T10:00:00Z'));

      expect(await service.hasConsent('c1', 'convite_atividades')).toBe(true);
      expect(await service.hasConsent('c1', 'captacao_recursos')).toBe(false);
    });
  });

  describe('reinstate() — VOLTAR (spec §2.7 regra 5)', () => {
    it('restaura os GRANTs que estavam ativos imediatamente antes do REVOKE global', async () => {
      await grant('convite_atividades', new Date('2026-07-01T10:00:00Z'));
      await grant('captacao_recursos', new Date('2026-07-01T10:00:00Z'));
      await revoke(GLOBAL_PURPOSE, new Date('2026-07-02T10:00:00Z'));

      const restored = await service.reinstate({
        contactId: 'c1',
        phoneE164: PHONE,
        source: ConsentSource.WA_KEYWORD,
        evidenceText: 'Você não receberá mais mensagens nossas. Para voltar, responda VOLTAR.',
      });

      expect(restored.sort()).toEqual(['captacao_recursos', 'convite_atividades']);
      expect(await service.hasConsent('c1', 'convite_atividades')).toBe(true);
      expect(await service.hasConsent('c1', 'captacao_recursos')).toBe(true);
      expect(await service.isSuppressed(PHONE)).toBe(false);
    });

    it('sem GRANT anterior: apenas levanta a supressão, sem conceder finalidade nenhuma', async () => {
      await revoke(GLOBAL_PURPOSE, new Date('2026-07-02T10:00:00Z'));
      expect(await service.isSuppressed(PHONE)).toBe(true);

      const restored = await service.reinstate({
        contactId: 'c1',
        phoneE164: PHONE,
        source: ConsentSource.WA_KEYWORD,
        evidenceText: 'confirmação de opt-out lida pelo contato',
      });

      expect(restored).toEqual([]);
      expect(await service.isSuppressed(PHONE)).toBe(false);
      expect(await service.hasConsent('c1', 'convite_atividades')).toBe(false);
    });
  });

  describe('idempotência', () => {
    it('GRANT repetido da mesma fonte para a mesma finalidade em 24h não gera evento novo', async () => {
      await grant('convite_atividades', new Date('2026-07-01T10:00:00Z'));
      await grant('convite_atividades', new Date('2026-07-01T10:05:00Z'));

      expect(db.events).toHaveLength(1);
      expect(await service.hasConsent('c1', 'convite_atividades')).toBe(true);
    });

    it('REVOKE global repetido (redelivery do webhook) não gera evento novo', async () => {
      await revoke(GLOBAL_PURPOSE, new Date('2026-07-02T10:00:00Z'));
      await revoke(GLOBAL_PURPOSE, new Date('2026-07-02T10:00:30Z'));

      expect(db.events).toHaveLength(1);
      expect(await service.isSuppressed(PHONE)).toBe(true);
    });

    it('NÃO engole um reconsentimento legítimo dentro da janela de 24h', async () => {
      // GRANT → PARAR → GRANT no mesmo dia. Se a idempotência olhasse só a
      // janela de 24h, o 2º GRANT casaria com o 1º e seria descartado — o
      // titular reconsentiu e continuaria revogado. Opt-in perdido em silêncio.
      await grant('convite_atividades', new Date('2026-07-01T10:00:00Z'));
      await revoke(GLOBAL_PURPOSE, new Date('2026-07-01T10:30:00Z'));
      await grant('convite_atividades', new Date('2026-07-01T10:45:00Z'));

      expect(db.events).toHaveLength(3);
      expect(await service.hasConsent('c1', 'convite_atividades')).toBe(true);
      expect(await service.isSuppressed(PHONE)).toBe(false);
    });
  });

  describe('cache derivado em Contact (nunca escrito à mão)', () => {
    it('GRANT atualiza optInAt/optInSource com o GRANT ativo mais recente de qualquer finalidade', async () => {
      await grant('convite_atividades', new Date('2026-07-01T10:00:00Z'), ConsentSource.WEB_FORM);
      await grant('captacao_recursos', new Date('2026-07-05T10:00:00Z'), ConsentSource.WA_BUTTON);

      expect(db.contacts.get('c1')).toMatchObject({
        optInAt: new Date('2026-07-05T10:00:00Z'),
        optInSource: ConsentSource.WA_BUTTON,
        optedOut: false,
      });
    });

    it('REVOKE global zera o cache de opt-in e marca optedOut', async () => {
      await grant('convite_atividades', new Date('2026-07-01T10:00:00Z'));
      await revoke(GLOBAL_PURPOSE, new Date('2026-07-02T10:00:00Z'));

      expect(db.contacts.get('c1')).toMatchObject({
        optInAt: null,
        optInSource: null,
        optedOut: true,
      });
    });
  });

  describe('isSuppressed()', () => {
    it('casa as duas formas brasileiras do número (com e sem o 9º dígito)', async () => {
      await revoke(GLOBAL_PURPOSE, new Date('2026-07-02T10:00:00Z'));

      // O mesmo titular, gravado na planilha sem o nono dígito.
      expect(await service.isSuppressed(PHONE_LEGACY)).toBe(true);
    });

    it('telefone nunca revogado não está suprimido', async () => {
      expect(await service.isSuppressed('+5592900000000')).toBe(false);
    });
  });

  describe('suppressedPhones() — consulta em lote (pipeline de importação)', () => {
    it('devolve só os telefones suprimidos, em UMA consulta', async () => {
      await revoke(GLOBAL_PURPOSE, new Date('2026-07-02T10:00:00Z'));
      db.prisma.suppressionList.findMany.mockClear();

      const result = await service.suppressedPhones([
        PHONE,
        '+5592900000000',
        '+5592911112222',
      ]);

      expect([...result]).toEqual([PHONE]);
      // Uma planilha de 13k linhas não pode virar 13k round-trips.
      expect(db.prisma.suppressionList.findMany).toHaveBeenCalledTimes(1);
    });

    it('casa o telefone da planilha na forma legada com a supressão gravada na moderna', async () => {
      await revoke(GLOBAL_PURPOSE, new Date('2026-07-02T10:00:00Z'));

      const result = await service.suppressedPhones([PHONE_LEGACY]);

      expect(result.has(PHONE_LEGACY)).toBe(true);
    });

    it('lista vazia não consulta o banco', async () => {
      db.prisma.suppressionList.findMany.mockClear();
      expect(await service.suppressedPhones([])).toEqual(new Set());
      expect(db.prisma.suppressionList.findMany).not.toHaveBeenCalled();
    });
  });

  describe('hasConsent()', () => {
    it('estado REVOKED não é consentimento', async () => {
      await grant('convite_atividades', new Date('2026-07-01T10:00:00Z'));
      await revoke('convite_atividades', new Date('2026-07-02T10:00:00Z'));

      const row = db.contactConsents.get('c1:convite_atividades');
      expect(row.state).toBe(ConsentState.REVOKED);
      expect(row.grantedAt).toBeInstanceOf(Date); // a trilha do GRANT não some
      expect(await service.hasConsent('c1', 'convite_atividades')).toBe(false);
    });
  });

  /**
   * C5.3 — RECONSTRUÇÃO POR phoneHash (pendência aberta no C1).
   *
   * O buraco: `ContactConsent` é chaveado por `contactId` e cai por CASCATA
   * quando o contato é apagado. A `SuppressionList` sobrevive (é chaveada por
   * `phoneHash`), mas os GRANTs não — então um contato que consentiu, foi
   * excluído e voltou por reimportação de planilha renascia SEM consentimento, e
   * o gate (corretamente) o pulava. O consentimento existia na trilha e o orgamind
   * não conseguia enxergá-lo.
   *
   * O conserto é a trilha: `ConsentEvent` é append-only e chaveado por
   * `phoneHash` durável — e é a partir DELA que o estado derivado se reidrata,
   * aplicando a mesma precedência do §2.7.
   */
  describe('rehydrate() — o ciclo consentiu → deletado → reimportado', () => {
    /** O que o Postgres faz sozinho: ON DELETE CASCADE em ContactConsent. */
    const deleteContact = (contactId: string) => {
      db.contacts.delete(contactId);
      for (const key of [...db.contactConsents.keys()]) {
        if (key.startsWith(`${contactId}:`)) db.contactConsents.delete(key);
      }
    };

    /** A reimportação por XLSX: MESMO telefone, contactId NOVO (cuid novo). */
    const reimport = (contactId: string) => {
      db.contacts.set(contactId, {
        id: contactId,
        phoneE164: PHONE,
        optInAt: null,
        optInSource: null,
        optedOut: false,
      });
    };

    it('o consentimento VOLTA: GRANT → delete → reimport → o contato novo consente', async () => {
      await grant('convite_atividades', new Date('2026-07-01T10:00:00Z'));
      expect(await service.hasConsent('c1', 'convite_atividades')).toBe(true);

      deleteContact('c1');
      reimport('c2');
      // O estado derivado morreu com o contato — é este o bug.
      expect(await service.hasConsent('c2', 'convite_atividades')).toBe(false);

      const restored = await service.rehydrate('c2', PHONE);

      expect(restored).toEqual(['convite_atividades']);
      expect(await service.hasConsent('c2', 'convite_atividades')).toBe(true);
      // Reidratar é PROJETAR a trilha, não praticar um ato novo: nenhum
      // ConsentEvent é criado (seria um consentimento que o titular não deu).
      expect(db.events).toHaveLength(1);
    });

    it('o opt-out também volta: REVOKE por finalidade sobrevive ao ciclo', async () => {
      await grant('convite_atividades', new Date('2026-07-01T10:00:00Z'));
      await revoke('convite_atividades', new Date('2026-07-02T10:00:00Z'));

      deleteContact('c1');
      reimport('c2');
      await service.rehydrate('c2', PHONE);

      // Sem a reidratação, este REVOKE por finalidade evaporava: a supressão
      // global é durável, mas um "não quero MAIS convites" (sem PARAR) morria com
      // a linha do contato, e a planilha ressuscitava o consentimento revogado.
      expect(await service.hasConsent('c2', 'convite_atividades')).toBe(false);
      expect(db.contactConsents.get('c2:convite_atividades')?.state).toBe(
        ConsentState.REVOKED,
      );
    });

    it('REVOKE global sobrevive: o contato reimportado nasce suprimido e sem finalidade', async () => {
      await grant('convite_atividades', new Date('2026-07-01T10:00:00Z'));
      await revoke(GLOBAL_PURPOSE, new Date('2026-07-02T10:00:00Z'));

      deleteContact('c1');
      reimport('c2');
      const restored = await service.rehydrate('c2', PHONE);

      expect(restored).toEqual([]);
      expect(await service.hasConsent('c2', 'convite_atividades')).toBe(false);
      expect(await service.isSuppressed(PHONE)).toBe(true);
      expect(db.contacts.get('c2')).toMatchObject({ optedOut: true, optInAt: null });
    });

    it('aplica a precedência do §2.7 sobre a trilha inteira (GRANT → REVOKE → GRANT)', async () => {
      await grant('convite_atividades', new Date('2026-07-01T10:00:00Z'));
      await revoke(GLOBAL_PURPOSE, new Date('2026-07-02T10:00:00Z'));
      await grant('convite_atividades', new Date('2026-07-03T10:00:00Z'));

      deleteContact('c1');
      reimport('c2');
      const restored = await service.rehydrate('c2', PHONE);

      // O GRANT mais recente vence o REVOKE global anterior E levanta a supressão
      // — a mesma regra 4 que o record() aplica ao vivo.
      expect(restored).toEqual(['convite_atividades']);
      expect(await service.isSuppressed(PHONE)).toBe(false);
      expect(db.contacts.get('c2')).toMatchObject({
        optInAt: new Date('2026-07-03T10:00:00Z'),
        optInSource: ConsentSource.WEB_FORM,
        optedOut: false,
      });
    });

    it('casa o telefone na forma legada (8 dígitos) com a trilha gravada na moderna', async () => {
      await grant('convite_atividades', new Date('2026-07-01T10:00:00Z'));

      deleteContact('c1');
      // A planilha do IDASAM traz o número sem o nono dígito — o mesmo titular.
      db.contacts.set('c2', {
        id: 'c2',
        phoneE164: PHONE_LEGACY,
        optInAt: null,
        optInSource: null,
        optedOut: false,
      });

      const restored = await service.rehydrate('c2', PHONE_LEGACY);

      expect(restored).toEqual(['convite_atividades']);
      expect(await service.hasConsent('c2', 'convite_atividades')).toBe(true);
    });

    it('contato sem trilha nenhuma: não faz nada e não consulta o resto', async () => {
      reimport('c9');
      db.prisma.contactConsent.upsert.mockClear();

      const restored = await service.rehydrate('c9', '+5592900000000');

      expect(restored).toEqual([]);
      expect(db.prisma.contactConsent.upsert).not.toHaveBeenCalled();
    });

    it('depois de reimportado, um GRANT retroativo NÃO sobrescreve um REVOKE mais novo', async () => {
      // A ficha de papel assinada em janeiro é importada em julho, DEPOIS de a
      // pessoa ter dado PARAR em junho. A precedência é por `occurredAt`: o
      // PARAR é mais novo e vence.
      //
      // Este é o caso que a reidratação sozinha não salva: se o recompute do
      // estado derivado olhasse só os eventos com o contactId ATUAL, ele não
      // enxergaria o REVOKE da encarnação anterior do contato — e o GRANT velho
      // passaria a valer. Um opt-out ressuscitado em silêncio, que é exatamente o
      // bug que a supressão durável existe para impedir.
      await revoke('convite_atividades', new Date('2026-06-01T10:00:00Z'));

      deleteContact('c1');
      reimport('c2');
      await service.rehydrate('c2', PHONE);

      await service.record({
        contactId: 'c2',
        phoneE164: PHONE,
        purposeKey: 'convite_atividades',
        action: ConsentAction.GRANT,
        source: ConsentSource.PAPER_FORM,
        evidenceText: 'Ficha assinada na feira de janeiro.',
        occurredAt: new Date('2026-01-15T10:00:00Z'),
      });

      expect(await service.hasConsent('c2', 'convite_atividades')).toBe(false);
    });

    it('é idempotente: reidratar duas vezes não muda o estado nem cria evento', async () => {
      await grant('convite_atividades', new Date('2026-07-01T10:00:00Z'));
      deleteContact('c1');
      reimport('c2');

      await service.rehydrate('c2', PHONE);
      const first = { ...db.contactConsents.get('c2:convite_atividades') };
      await service.rehydrate('c2', PHONE);

      expect(db.contactConsents.get('c2:convite_atividades')).toEqual(first);
      expect(db.events).toHaveLength(1);
    });
  });

  /**
   * Bug LGPD (webhooks.service.ts): `processStopKeywords` fazia `if (!contact)
   * continue` ANTES de qualquer Contact existir — um número nunca visto que
   * mandava PARAR como primeira mensagem tinha o opt-out silenciosamente
   * descartado. O conserto é chamar `record({ contactId: null, ... })`: a
   * REVOKE global já é gravada por `phoneHash`, então nunca precisou de um
   * Contact para existir. Estes testes cobrem a trilha `record()`/`rehydrate()`
   * pelo lado do ConsentService (sem mockar `WebhooksService`).
   */
  describe('REVOKE global com contactId null — número desconhecido (bug LGPD)', () => {
    const UNKNOWN_PHONE = '+5592900009999';

    it('grava o ConsentEvent (contactId null) e a SuppressionList mesmo sem Contact', async () => {
      await service.record({
        contactId: null,
        phoneE164: UNKNOWN_PHONE,
        purposeKey: GLOBAL_PURPOSE,
        action: ConsentAction.REVOKE,
        source: ConsentSource.WA_KEYWORD,
        evidenceText: 'PARAR',
        suppressionReason: 'keyword_parar',
      });

      expect(db.events).toHaveLength(1);
      expect(db.events[0]).toMatchObject({
        contactId: null,
        phoneHash: phoneHash(UNKNOWN_PHONE, SALT),
        purposeKey: GLOBAL_PURPOSE,
        action: ConsentAction.REVOKE,
      });
      expect(await service.isSuppressed(UNKNOWN_PHONE)).toBe(true);
    });

    it('continua suprimido quando o Contact nasce DEPOIS (planilha ou QR) — rehydrate por phoneHash cobre o REVOKE sem Contact', async () => {
      await service.record({
        contactId: null,
        phoneE164: UNKNOWN_PHONE,
        purposeKey: GLOBAL_PURPOSE,
        action: ConsentAction.REVOKE,
        source: ConsentSource.WA_KEYWORD,
        evidenceText: 'PARAR',
        suppressionReason: 'keyword_parar',
      });

      // O contato nasce depois — reimportação de planilha (excel.service.ts) ou
      // um inbound novo casando com o QR/link (chat-ingest ensureContact) — com
      // um cuid novo, exatamente como no ciclo consentiu→deletado→reimportado.
      db.contacts.set('c-new', {
        id: 'c-new',
        phoneE164: UNKNOWN_PHONE,
        optInAt: null,
        optInSource: null,
        optedOut: false,
      });
      const restored = await service.rehydrate('c-new', UNKNOWN_PHONE);

      // Nenhuma finalidade foi concedida — só existe o REVOKE global na trilha.
      expect(restored).toEqual([]);
      expect(await service.isSuppressed(UNKNOWN_PHONE)).toBe(true);
      expect(db.contacts.get('c-new')).toMatchObject({
        optedOut: true,
        optInAt: null,
      });
    });

    it('um GRANT de finalidade específica (texto de autorização do QR, com prova de posse) DEPOIS levanta a supressão — regra 4, não é ressurreição silenciosa', async () => {
      // occurredAt explícito nos dois record() — como todo o resto do arquivo
      // já faz — para não depender de `new Date()` (o REVOKE e o GRANT podem
      // colidir no mesmo milissegundo, e o desempate "REVOKE vence" engoliria
      // o GRANT por um motivo que não tem nada a ver com a regra sendo testada).
      await service.record({
        contactId: null,
        phoneE164: UNKNOWN_PHONE,
        purposeKey: GLOBAL_PURPOSE,
        action: ConsentAction.REVOKE,
        source: ConsentSource.WA_KEYWORD,
        evidenceText: 'PARAR',
        suppressionReason: 'keyword_parar',
        occurredAt: new Date('2026-07-01T10:00:00Z'),
      });
      db.contacts.set('c-new', {
        id: 'c-new',
        phoneE164: UNKNOWN_PHONE,
        optInAt: null,
        optInSource: null,
        optedOut: false,
      });
      await service.rehydrate('c-new', UNKNOWN_PHONE);
      expect(await service.isSuppressed(UNKNOWN_PHONE)).toBe(true);

      // A pessoa manda o texto pré-preenchido do link/QR — CASA com um
      // OptInLink ativo (chat-ingest `recordLinkOptIn`), e chega com um wamid
      // verificável: é um ato afirmativo, provado, que DECLARA a finalidade —
      // não um inbound genérico. Regra 4 do §2.7: um GRANT posterior a um
      // REVOKE global reabre SÓ a finalidade que ele declara, e levanta a
      // supressão. Não é "silencioso": exige texto exato + prova de posse,
      // exatamente o que distingue este caminho do formulário web público
      // (PublicConsentService recusa GRANT em telefone suprimido ANTES de
      // chamar record(), porque um formulário não prova posse do número).
      await service.record({
        contactId: 'c-new',
        phoneE164: UNKNOWN_PHONE,
        purposeKey: 'convite_atividades',
        action: ConsentAction.GRANT,
        source: ConsentSource.WA_LINK,
        evidenceText:
          'Autorizo o IDASAM a me enviar mensagens no WhatsApp sobre convites para cursos, oficinas e eventos.',
        occurredAt: new Date('2026-07-02T10:00:00Z'),
      });

      expect(await service.hasConsent('c-new', 'convite_atividades')).toBe(true);
      expect(await service.isSuppressed(UNKNOWN_PHONE)).toBe(false);
    });
  });

  /**
   * C1b — a UI precisa OFERECER a finalidade. Sem uma lista, o operador não tem
   * como declarar a finalidade da campanha, e o gate (corretamente) não passa
   * ninguém: a feature inteira nasce morta.
   */
  describe('listPurposes()', () => {
    it('devolve só as finalidades ATIVAS, com o que a UI precisa exibir', async () => {
      db.prisma.consentPurpose.findMany.mockResolvedValue([
        {
          key: 'convite_atividades',
          label: 'Convites para cursos, oficinas e eventos',
          description: 'inscrições, chamadas, mutirões',
          isSensitive: false,
        },
      ] as never);

      const purposes = await service.listPurposes();

      expect(purposes).toEqual([
        {
          key: 'convite_atividades',
          label: 'Convites para cursos, oficinas e eventos',
          description: 'inscrições, chamadas, mutirões',
          isSensitive: false,
        },
      ]);
      expect(db.prisma.consentPurpose.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { active: true } }),
      );
    });
  });

  /**
   * C1b — o número que o operador precisa ver ANTES de disparar: de N contatos
   * filtrados, quantos consentiram para ESTA finalidade. Sem isso, ele descobre
   * que 13k viraram SKIPPED_NO_CONSENT depois do disparo.
   */
  describe('countGrantedInAudience()', () => {
    it('conta a audiência com GRANT ativo para a finalidade (excluindo optedOut)', async () => {
      db.prisma.contact.count.mockResolvedValue(37 as never);

      const total = await service.countGrantedInAudience(
        { tags: { has: 'feira' } } as never,
        'convite_atividades',
      );

      expect(total).toBe(37);
      expect(db.prisma.contact.count).toHaveBeenCalledWith({
        where: {
          AND: [
            { tags: { has: 'feira' } },
            { optedOut: false },
            {
              consents: {
                some: {
                  purposeKey: 'convite_atividades',
                  state: ConsentState.GRANTED,
                },
              },
            },
          ],
        },
      });
    });

    it('sem finalidade, ninguém consentiu — e não consulta o banco', async () => {
      db.prisma.contact.count.mockClear();
      expect(await service.countGrantedInAudience({} as never, null)).toBe(0);
      expect(db.prisma.contact.count).not.toHaveBeenCalled();
    });
  });

  /**
   * "Quantos consentiram" ≠ "quantos o gate deixa passar". O gate autoriza por
   * grant OU por janela de atendimento aberta; a UI trava o botão de disparo com
   * este número, então ele TEM que ser o do gate — senão a tela bloqueia um
   * envio legítimo (o bug do gate silencioso ao contrário).
   */
  describe('countEligibleInAudience()', () => {
    const since = new Date('2026-07-09T12:00:00Z');

    it('sem janela: só o GRANT explícito conta', async () => {
      db.prisma.contact.count.mockResolvedValue(12 as never);

      const total = await service.countEligibleInAudience(
        { tags: { has: 'feira' } } as never,
        'captacao_recursos',
        null,
      );

      expect(total).toBe(12);
      expect(db.prisma.contact.count).toHaveBeenCalledWith({
        where: {
          AND: [
            { tags: { has: 'feira' } },
            { optedOut: false },
            {
              OR: [
                {
                  consents: {
                    some: {
                      purposeKey: 'captacao_recursos',
                      state: ConsentState.GRANTED,
                    },
                  },
                },
              ],
            },
          ],
        },
      });
    });

    it('com janela: quem respondeu nas últimas 24h entra no OR (o gate envia)', async () => {
      db.prisma.contact.count.mockResolvedValue(200 as never);

      const total = await service.countEligibleInAudience(
        {} as never,
        'servico_projeto',
        { instanceId: 'inst-1', since },
      );

      expect(total).toBe(200);
      const arg = db.prisma.contact.count.mock.calls.at(-1)?.[0] as {
        where: { AND: Array<{ OR?: unknown[] }> };
      };
      expect(arg.where.AND[2].OR).toEqual([
        {
          consents: {
            some: {
              purposeKey: 'servico_projeto',
              state: ConsentState.GRANTED,
            },
          },
        },
        {
          conversations: {
            some: { instanceId: 'inst-1', lastInboundAt: { gt: since } },
          },
        },
      ]);
    });

    it('sem finalidade: zero, sem consultar o banco (uma key vazia não autoriza nada)', async () => {
      db.prisma.contact.count.mockClear();
      expect(await service.countEligibleInAudience({} as never, null)).toBe(0);
      expect(db.prisma.contact.count).not.toHaveBeenCalled();
    });

    // A supressão é absoluta (art. 8º §5º) e o gate a aplica ANTES de tudo:
    // prometer que um opt-out receberia seria mentira na tela.
    it('optedOut nunca é elegível, nem com janela aberta', async () => {
      db.prisma.contact.count.mockResolvedValue(0 as never);
      await service.countEligibleInAudience({} as never, 'servico_projeto', {
        instanceId: 'inst-1',
        since,
      });
      const arg = db.prisma.contact.count.mock.calls.at(-1)?.[0] as {
        where: { AND: unknown[] };
      };
      expect(arg.where.AND).toContainEqual({ optedOut: false });
    });
  });

  /**
   * Uma `purposeKey` inexistente/inativa é indistinguível, no gate, de uma
   * campanha sem finalidade: ninguém recebe. Melhor recusar na criação.
   */
  describe('findActivePurpose()', () => {
    it('encontra a finalidade ativa pela key', async () => {
      db.prisma.consentPurpose.findFirst.mockResolvedValue({
        key: 'captacao_recursos',
        label: 'Campanhas de doação e apoio',
        description: 'arrecadação',
        isSensitive: false,
      } as never);

      await expect(service.findActivePurpose('captacao_recursos')).resolves.toMatchObject({
        key: 'captacao_recursos',
      });
      expect(db.prisma.consentPurpose.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { key: 'captacao_recursos', active: true },
        }),
      );
    });

    it('devolve null para finalidade inexistente ou inativa', async () => {
      db.prisma.consentPurpose.findFirst.mockResolvedValue(null as never);
      await expect(service.findActivePurpose('nao_existe')).resolves.toBeNull();
    });

    it('não consulta o banco sem key (nem com a sentinela global)', async () => {
      db.prisma.consentPurpose.findFirst.mockClear();
      await expect(service.findActivePurpose(null)).resolves.toBeNull();
      await expect(service.findActivePurpose(GLOBAL_PURPOSE)).resolves.toBeNull();
      expect(db.prisma.consentPurpose.findFirst).not.toHaveBeenCalled();
    });
  });
});
