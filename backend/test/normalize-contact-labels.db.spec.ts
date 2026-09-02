import { PrismaClient } from '@prisma/client';
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { assertTestDatabase, shouldRunDbTests } from './require-test-db';
import { normalizeContactLabels } from '../prisma/normalize-contact-labels';

const prisma = new PrismaClient();

async function resetDb() {
  assertTestDatabase();
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "Message", "Campaign", "Template", "ImportItem", "ImportBatch",
      "Contact", "WhatsappConnectionEvent", "WhatsappInstance", "AuditEvent"
    RESTART IDENTITY CASCADE;
  `);
}

const RUN_DB_TESTS = shouldRunDbTests();

if (!RUN_DB_TESTS) {
  // eslint-disable-next-line no-console
  console.warn(
    '[normalize-contact-labels.db.spec] PULANDO: PICOA_DB_TESTS não está setada. Para rodar: ' +
      "PICOA_DB_TESTS=1 DATABASE_URL='postgresql://picoa:picoa@127.0.0.1:55432/picoa_test?schema=public' " +
      'bunx vitest run test/normalize-contact-labels.db.spec.ts',
  );
}

/**
 * NORMALIZAÇÃO RETROATIVA de cidade/grupo/tags (spec 2026-08-25, §2.2) —
 * continuação de prisma/normalize-contact-labels.spec.ts.
 *
 * ★ POR QUE ESTE TESTE PRECISA DE POSTGRES DE VERDADE.
 *
 * O filtro `tags: { isEmpty: false }` é um operador de ARRAY que o Prisma
 * traduz de um jeito específico do Postgres — um mock de Prisma IGNORA
 * `where` inteiro, então não prova que um contato com `tags: []` fica de
 * fora da varredura. E só o banco real prova o ciclo inteiro: dry-run não
 * escreve nada, `--apply` escreve, e rodar de novo não acha mais cluster
 * nenhum (idempotência de verdade, não só a promessa do comentário) —
 * incluindo o `groupBy` que `contacts.repository.ts#facets()` usa e que é
 * exatamente onde o sintoma do cliente ("Manaus" e "manaus" como duas
 * entradas) aparece na tela.
 */
describe.skipIf(!RUN_DB_TESTS)(
  'normalizeContactLabels contra Postgres real (requer banco de teste)',
  () => {
    beforeAll(() => {
      assertTestDatabase();
    });

    afterAll(async () => {
      await prisma.$disconnect();
    });

    beforeEach(async () => {
      await resetDb();
      await prisma.contact.createMany({
        data: [
          {
            id: 'c1',
            phoneE164: '+5592900000001',
            city: 'Manaus',
            group: 'apoiadores',
            tags: ['vip', 'prio'],
            createdAt: new Date('2026-01-01T00:00:00Z'),
          },
          {
            id: 'c2',
            phoneE164: '+5592900000002',
            city: 'Manaus',
            group: 'Apoiadores',
            tags: [],
            createdAt: new Date('2026-02-01T00:00:00Z'),
          },
          {
            id: 'c3',
            phoneE164: '+5592900000003',
            city: 'manaus',
            group: null,
            tags: ['VIP'],
            createdAt: new Date('2026-01-15T00:00:00Z'),
          },
          {
            id: 'c4',
            phoneE164: '+5592900000004',
            city: 'MANAUS',
            group: null,
            tags: [],
            createdAt: new Date('2026-01-20T00:00:00Z'),
          },
          {
            id: 'c5',
            phoneE164: '+5592900000005',
            city: 'Belém',
            group: null,
            tags: [],
            createdAt: new Date('2026-01-10T00:00:00Z'),
          },
        ],
      });
    });

    it('dry-run: agrupa Manaus/manaus/MANAUS num cluster só, com "Manaus" eleito (2×1×1) e não escreve nada', async () => {
      const r = await normalizeContactLabels(prisma);
      expect(r.apply).toBe(false);
      expect(r.city.clusters).toHaveLength(1);
      expect(r.city.clusters[0].canonical).toBe('Manaus');
      expect(r.city.clusters[0].contactsAffected).toBe(2); // manaus + MANAUS

      // Nada foi escrito ainda: continuam 4 valores CRUS distintos na base
      // ('Manaus', 'manaus', 'MANAUS', 'Belém') — o cluster acima é o
      // relatório do que MUDARIA, não uma prévia de escrita.
      const cities = await prisma.contact.groupBy({ by: ['city'], _count: true });
      expect(cities.filter((g) => g.city !== null)).toHaveLength(4); // nada mudou
    });

    it('--apply reescreve as variantes e o cluster desaparece numa segunda rodada (idempotente)', async () => {
      await normalizeContactLabels(prisma, { apply: true });

      const cities = await prisma.contact.findMany({
        where: { id: { in: ['c1', 'c2', 'c3', 'c4'] } },
        select: { city: true },
      });
      expect(cities.every((c) => c.city === 'Manaus')).toBe(true);

      const second = await normalizeContactLabels(prisma, { apply: true });
      expect(second.city.clusters).toHaveLength(0); // nada mais para fundir
    });

    it('grupo: "apoiadores" (c1) e "Apoiadores" (c2) empatam em frequência — vence o mais antigo (c1)', async () => {
      const r = await normalizeContactLabels(prisma, { apply: true });
      expect(r.group.clusters[0].canonical).toBe('apoiadores');
      const c2 = await prisma.contact.findUniqueOrThrow({ where: { id: 'c2' } });
      expect(c2.group).toBe('apoiadores');
    });

    it('tags: "VIP" (c3) funde para "vip"; contato sem tag (c2, tags: []) fica de fora da varredura', async () => {
      const r = await normalizeContactLabels(prisma, { apply: true });
      const c3 = await prisma.contact.findUniqueOrThrow({ where: { id: 'c3' } });
      expect(c3.tags).toEqual(['vip']);
      const c1 = await prisma.contact.findUniqueOrThrow({ where: { id: 'c1' } });
      expect(c1.tags).toEqual(['vip', 'prio']); // já era canônico, não muda
      expect(r.tags.contactsUpdated).toBe(1); // só c3
    });
  },
);
