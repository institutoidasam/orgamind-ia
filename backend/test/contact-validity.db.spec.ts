import { PrismaClient } from '@prisma/client';
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { assertTestDatabase, shouldRunDbTests } from './require-test-db';
import {
  contactValidityWhere,
  excludeInvalidWhere,
  invalidContactWhere,
  unvalidatedContactWhere,
  validContactWhere,
} from '../src/shared/contact-validity';
import { buildContactListWhere } from '../src/modules/contacts/contacts.repository';

const prisma = new PrismaClient();

/**
 * O modelo Prisma é `Channel` (accessor `prisma.channel`), mas a TABELA no
 * banco é `WhatsappInstance` (`@@map("WhatsappInstance")` em schema.prisma) —
 * é o único `@@map` do schema. O TRUNCATE abaixo usa o nome de TABELA; o
 * `.create` abaixo usa o nome de MODELO. Os dois nomes divergem de propósito.
 */
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
    '[contact-validity.db.spec] PULANDO: PICOA_DB_TESTS não está setada. Este spec faz TRUNCATE ' +
      'CASCADE num Postgres real. Para rodar: PICOA_DB_TESTS=1 DATABASE_URL=postgresql://.../picoa_test ' +
      'bunx vitest run test/contact-validity.db.spec.ts',
  );
}

/**
 * ★ POR QUE ESTE TESTE EXISTE, E POR QUE ELE PRECISA DE UM BANCO DE VERDADE.
 *
 * Os testes unitários da Fase B travam a FORMA do `where` (o mock do Prisma
 * ignora `where`, então é o que dá para fazer lá). Só o Postgres responde a
 * pergunta que importa: `lastFailureReason NOT IN ('SEM_WHATSAPP', …)` CASA a
 * linha cujo valor é NULL? Não casa — e como quase toda a base é NULL, é essa
 * resposta que decide se a campanha sai para treze mil pessoas ou para zero.
 */
describe.skipIf(!RUN_DB_TESTS)(
  'validade de contato contra Postgres real (requer banco de teste)',
  () => {
    beforeAll(() => {
      assertTestDatabase();
    });

    afterAll(async () => {
      await prisma.$disconnect();
    });

    beforeEach(async () => {
      await resetDb();
      const channel = await prisma.channel.create({
        data: { name: 'robo-teste', provider: 'GOZAP' },
      });

      await prisma.contact.createMany({
        data: [
          // 1) O CASO CRÍTICO: nulo em tudo, nunca recebeu nada.
          { id: 'mudo', phoneE164: '+5592900000001' },
          // 2) Recusado pelo WhatsApp.
          {
            id: 'recusado',
            phoneE164: '+5592900000002',
            whatsappValid: false,
          },
          // 3) Falha definitiva de número inexistente, com whatsappValid NULL.
          {
            id: 'sem-whatsapp',
            phoneE164: '+5592900000003',
            lastFailureReason: 'SEM_WHATSAPP',
            failureCount: 1,
          },
          // 4) Confirmado pelo provedor.
          {
            id: 'confirmado',
            phoneE164: '+5592900000004',
            whatsappValid: true,
          },
          // 5) Nulo em tudo, MAS com uma entrega provada (criada abaixo).
          { id: 'entregue', phoneE164: '+5592900000005' },
          // 6) Optou por sair: o NÚMERO continua sem veredito.
          {
            id: 'opt-out',
            phoneE164: '+5592900000006',
            lastFailureReason: 'OPT_OUT',
            failureCount: 1,
          },
        ],
      });

      await prisma.message.create({
        data: {
          contactId: 'entregue',
          instanceId: channel.id,
          direction: 'OUTBOUND',
          status: 'DELIVERED',
        },
      });
      // SENT sozinho NÃO prova entrega (incidente do 9º dígito): o contato
      // "mudo" continua não validado mesmo com esta linha.
      await prisma.message.create({
        data: {
          contactId: 'mudo',
          instanceId: channel.id,
          direction: 'OUTBOUND',
          status: 'SENT',
        },
      });
    });

    const ids = async (where: object) =>
      (
        await prisma.contact.findMany({
          where: where as never,
          select: { id: true },
          orderBy: { id: 'asc' },
        })
      ).map((c) => c.id);

    it('★ o contato TODO NULO é "não validado" — o NOT IN não o descarta', async () => {
      expect(await ids(unvalidatedContactWhere())).toEqual([
        'mudo',
        'opt-out',
      ]);
    });

    it('inválido confirmado pega os dois sinais, e SÓ eles', async () => {
      expect(await ids(invalidContactWhere())).toEqual([
        'recusado',
        'sem-whatsapp',
      ]);
    });

    it('válido inclui quem tem entrega DELIVERED, não quem só tem SENT', async () => {
      expect(await ids(validContactWhere())).toEqual([
        'confirmado',
        'entregue',
      ]);
    });

    it('excludeInvalidWhere mantém TODO MUNDO menos os inválidos (inclusive os nulos)', async () => {
      expect(await ids(excludeInvalidWhere())).toEqual([
        'confirmado',
        'entregue',
        'mudo',
        'opt-out',
      ]);
    });

    // Disjuntas e exaustivas: se as três não somarem o total, algum contato
    // aparece em dois filtros — ou em nenhum.
    it('as três classes particionam a base', async () => {
      const total = await prisma.contact.count();
      const counts = await Promise.all(
        (['valid', 'invalid', 'unvalidated'] as const).map((v) =>
          prisma.contact.count({ where: contactValidityWhere(v) as never }),
        ),
      );
      expect(counts.reduce((a, b) => a + b, 0)).toBe(total);
      expect(total).toBe(6);
    });

    it('o filtro da LISTA devolve o mesmo conjunto do helper', async () => {
      const where = buildContactListWhere({
        page: 1,
        pageSize: 50,
        validity: 'invalid',
      });
      expect(await ids(where)).toEqual(['recusado', 'sem-whatsapp']);
    });

    it('filtro de validade e filtro de cidade se combinam (nenhum sobrescreve o outro)', async () => {
      await prisma.contact.update({
        where: { id: 'recusado' },
        data: { city: 'Manaus' },
      });
      const where = buildContactListWhere({
        page: 1,
        pageSize: 50,
        validity: 'invalid',
        city: 'Manaus',
      });
      expect(await ids(where)).toEqual(['recusado']);
    });

    /**
     * O ciclo completo do pedido do cliente: filtrar inválidos → apagar →
     * lista vazia. E a CONSEQUÊNCIA declarada na confirmação: a cascata leva
     * as mensagens junto.
     */
    it('apagar por predicado remove exatamente os inválidos — e o histórico deles junto', async () => {
      await prisma.message.create({
        data: {
          contactId: 'recusado',
          instanceId: (await prisma.channel.findFirstOrThrow()).id,
          direction: 'OUTBOUND',
          status: 'FAILED',
          errorCode: 'gozap.not_on_whatsapp',
        },
      });
      const antes = await prisma.message.count();

      const deleted = await prisma.contact.deleteMany({
        where: invalidContactWhere() as never,
      });

      expect(deleted.count).toBe(2);
      expect(await ids(invalidContactWhere())).toEqual([]);
      expect(await prisma.contact.count()).toBe(4);
      // Cascade: a mensagem que PROVAVA a invalidez foi embora com o contato.
      expect(await prisma.message.count()).toBe(antes - 1);
    });
  },
);
