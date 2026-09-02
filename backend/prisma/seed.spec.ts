import { PrismaClient } from '@prisma/client';
import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { runSeed } from './seed';
import { assertTestDatabase, shouldRunDbTests } from '../test/require-test-db';

const prisma = new PrismaClient();

async function resetDb() {
  // Última linha de defesa: mesmo que o skip do describe abaixo falhe por algum
  // motivo, isto recusa rodar TRUNCATE contra qualquer banco que não seja de teste.
  assertTestDatabase();
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "Message", "Campaign", "Template", "ImportItem", "ImportBatch",
      "Contact", "WhatsappConnectionEvent", "WhatsappInstance",
      "AuditEvent", "User",
      "ConsentEvent", "ContactConsent", "SuppressionList",
      "ConsentText", "ConsentPurpose", "Organization"
    RESTART IDENTITY CASCADE;
  `);
}

/**
 * O estado de um deploy que rodou a migração de referência (20260711120000):
 * as 5 finalidades e o texto canônico v1 — ambos com o IDASAM dentro, porque
 * nasceram quando o orgamind era de um cliente só.
 */
async function seedReferenceConsentData() {
  await prisma.consentPurpose.createMany({
    data: [
      {
        key: 'comunicacao_institucional',
        label: 'Notícias e avisos do IDASAM',
        description: 'Comunicados gerais do instituto.',
      },
      {
        key: 'convite_atividades',
        label: 'Convites para cursos, oficinas e eventos',
        description: 'Inscrições, chamadas e mutirões.',
      },
      {
        key: 'pesquisa_avaliacao',
        label: 'Pesquisas e avaliações',
        description: 'Monitoramento de projeto e pesquisas de satisfação.',
      },
      {
        key: 'captacao_recursos',
        label: 'Campanhas de doação e apoio',
        description: 'Arrecadação de recursos.',
      },
      {
        key: 'servico_projeto',
        label: 'Avisos operacionais do projeto em que participo',
        description:
          'Utility: data, local e mudanças das atividades do projeto.',
      },
    ],
  });
  await prisma.consentText.create({
    data: {
      version: 'optin-v1',
      purposeKey: 'convite_atividades',
      body: IDASAM_V1,
      activeFrom: new Date('2026-01-01T00:00:00Z'),
    },
  });
}

const IDASAM_V1 =
  'Autorizo o IDASAM (Instituto de Desenvolvimento Agropecuário e Florestal Sustentável do Amazonas) a me enviar mensagens no WhatsApp com convites para cursos, oficinas e eventos.\n' +
  'São no máximo 2 mensagens por mês. Posso sair quando quiser respondendo PARAR.\n' +
  'Minha resposta não afeta em nada meu acesso aos projetos e serviços do IDASAM.\n' +
  'Política de privacidade: {url}';

function setOrgEnv(name?: string, legalName?: string) {
  if (name === undefined) delete process.env.ORG_NAME;
  else process.env.ORG_NAME = name;
  if (legalName === undefined) delete process.env.ORG_LEGAL_NAME;
  else process.env.ORG_LEGAL_NAME = legalName;
}

// ── Trava de segurança (ver docs/superpowers/plans/2026-08-04-bug-vitest-trunca-banco-dev.md) ──
//
// Este spec toca um Postgres real (TRUNCATE ... CASCADE no beforeEach). Sem banco
// efêmero (Camada 2, ainda não implementada), a única defesa é: nunca rodar sem
// PICOA_DB_TESTS=1 setada explicitamente, e nunca rodar contra um banco que não seja
// reconhecidamente de teste (nome termina em "_test" — ver assertTestDatabase acima).
const RUN_DB_TESTS = shouldRunDbTests();

if (!RUN_DB_TESTS) {
  // eslint-disable-next-line no-console
  console.warn(
    '[seed.spec] PULANDO: PICOA_DB_TESTS não está setada. Este spec faz TRUNCATE CASCADE ' +
      'em um Postgres real e por padrão fica desligado para não arriscar o banco de dev. ' +
      'Para rodar de propósito: PICOA_DB_TESTS=1 DATABASE_URL=postgresql://.../algum_nome_test ' +
      'bunx vitest run seed.spec',
  );
}

describe.skipIf(!RUN_DB_TESTS)('prisma seed (integração — requer banco de teste real)', () => {
  beforeAll(() => {
    assertTestDatabase();
  });

  describe('prisma seed', () => {
    beforeEach(async () => {
      await resetDb();
      setOrgEnv('CONTINUUM', 'Canal do Matheus Garcia - CONTINUUM');
    });

    afterAll(async () => {
      await prisma.$disconnect();
    });

    it('creates admin and default WhatsappInstance on first run', async () => {
      process.env.EVOLUTION_INSTANCE_NAME = 'test-instance';
      process.env.EVOLUTION_API_KEY = 'test-key';
      process.env.SEED_ADMIN_EMAIL = 'admin@test.local';
      process.env.SEED_ADMIN_PASSWORD = 'changeme1234';

      await runSeed();

      const admin = await prisma.user.findUnique({ where: { email: 'admin@test.local' } });
      expect(admin).not.toBeNull();
      expect(admin!.role).toBe('ADMIN');

      const inst = await prisma.channel.findFirst({ where: { isDefault: true } });
      expect(inst).not.toBeNull();
      expect(inst!.evolutionInstanceName).toBe('test-instance');
      expect(inst!.apiKey).toBe('test-key');
    });

    it('is idempotent — running twice does not duplicate', async () => {
      await runSeed();
      await runSeed();

      const admins = await prisma.user.count({ where: { role: 'ADMIN' } });
      const instances = await prisma.channel.count();
      expect(admins).toBe(1);
      expect(instances).toBe(1);
    });
  });

  // ── Identidade da organização (a que vai para o TITULAR dos dados) ───────────

  describe('prisma seed — Organization', () => {
    beforeEach(async () => {
      await resetDb();
      setOrgEnv('CONTINUUM', 'Canal do Matheus Garcia - CONTINUUM');
    });

    afterAll(async () => {
      await prisma.$disconnect();
    });

    it('cria a organização a partir do env', async () => {
      await runSeed();

      const org = await prisma.organization.findFirst();
      expect(org).not.toBeNull();
      expect(org!.name).toBe('CONTINUUM');
      expect(org!.legalName).toBe('Canal do Matheus Garcia - CONTINUUM');
    });

    it('sem env, usa um fallback neutro — nunca o nome de outro cliente', async () => {
      setOrgEnv(undefined, undefined);

      await runSeed();

      const org = await prisma.organization.findFirst();
      expect(org).not.toBeNull();
      expect(org!.name).not.toMatch(/idasam/i);
      expect(org!.legalName).not.toMatch(/idasam/i);
    });

    it('é singleton e idempotente — dois deploys não criam duas organizações', async () => {
      await runSeed();
      await runSeed();

      expect(await prisma.organization.count()).toBe(1);
    });

    it('NÃO sobrescreve o que o operador editou na tela de Configurações', async () => {
      await runSeed();
      await prisma.organization.updateMany({
        data: { legalName: 'Matheus Garcia Comunicação LTDA' },
      });

      // Um redeploy roda o seed de novo. A tela é a fonte da verdade, não o env.
      await runSeed();

      const org = await prisma.organization.findFirst();
      expect(org!.legalName).toBe('Matheus Garcia Comunicação LTDA');
    });
  });

  // ── O texto de consentimento com a organização certa ─────────────────────────

  describe('prisma seed — ConsentText com a organização configurada', () => {
    beforeEach(async () => {
      await resetDb();
      setOrgEnv('CONTINUUM', 'Canal do Matheus Garcia - CONTINUUM');
      await seedReferenceConsentData();
    });

    afterAll(async () => {
      await prisma.$disconnect();
    });

    it('publica uma versão NOVA do texto, nomeando a organização configurada', async () => {
      await runSeed();

      const vigente = await prisma.consentText.findFirst({
        where: { purposeKey: 'convite_atividades' },
        orderBy: { activeFrom: 'desc' },
      });

      expect(vigente!.version).not.toBe('optin-v1');
      expect(vigente!.body).toContain('CONTINUUM');
      expect(vigente!.body).not.toMatch(/idasam/i);
    });

    it('NÃO reescreve a versão antiga — ela é a prova do que a pessoa leu', async () => {
      await runSeed();

      const v1 = await prisma.consentText.findFirst({
        where: { purposeKey: 'convite_atividades', version: 'optin-v1' },
      });
      expect(v1).not.toBeNull();
      expect(v1!.body).toBe(IDASAM_V1);
    });

    it('os consentimentos já colhidos continuam apontando para a versão que a pessoa viu', async () => {
      const contact = await prisma.contact.create({
        data: { phoneE164: '+5592988887777', tags: [] },
      });
      const event = await prisma.consentEvent.create({
        data: {
          contactId: contact.id,
          phoneHash: 'hash-da-maria',
          purposeKey: 'convite_atividades',
          action: 'GRANT',
          source: 'WEB_FORM',
          evidenceText: IDASAM_V1,
          consentTextVersion: 'optin-v1',
          occurredAt: new Date('2026-02-01T12:00:00Z'),
        },
      });

      await runSeed();

      const after = await prisma.consentEvent.findUnique({
        where: { id: event.id },
      });
      expect(after!.consentTextVersion).toBe('optin-v1');
      expect(after!.evidenceText).toBe(IDASAM_V1);
    });

    it('roda duas vezes sem empilhar versões — o texto que já nomeia a organização basta', async () => {
      await runSeed();
      await runSeed();

      const textos = await prisma.consentText.count({
        where: { purposeKey: 'convite_atividades' },
      });
      // v1 (IDASAM, histórica) + a versão nova. E só.
      expect(textos).toBe(2);
    });

    it('os rótulos das finalidades de referência são NEUTROS — não nomeiam organização nenhuma', async () => {
      // O rótulo vai para dentro do texto que o titular lê ("…mensagens no
      // WhatsApp sobre {rótulo}") e para a landing. Um rótulo que nomeia uma
      // organização é o mesmo bug do texto, só que mais escondido.
      await runSeed();

      const purposes = await prisma.consentPurpose.findMany();
      for (const p of purposes) {
        expect(p.label).not.toMatch(/idasam/i);
        expect(p.label).not.toMatch(/continuum/i);
      }
    });

    it('não toca em finalidade cujo texto vigente JÁ nomeia a organização', async () => {
      await prisma.consentPurpose.create({
        data: {
          key: 'continuum_avisos',
          label: 'Avisos do canal',
          description: 'Avisos.',
        },
      });
      await prisma.consentText.create({
        data: {
          version: 'escrito-a-mao',
          purposeKey: 'continuum_avisos',
          body: 'Autorizo o CONTINUUM a me enviar mensagens no WhatsApp.',
        },
      });

      await runSeed();

      const textos = await prisma.consentText.count({
        where: { purposeKey: 'continuum_avisos' },
      });
      expect(textos).toBe(1);
    });
  });

  // ── Rótulos das finalidades (o titular também os lê) ─────────────────────────

  describe('prisma seed — rótulos de finalidade', () => {
    beforeEach(async () => {
      await resetDb();
      setOrgEnv('CONTINUUM', 'Canal do Matheus Garcia - CONTINUUM');
      await seedReferenceConsentData();
    });

    afterAll(async () => {
      await prisma.$disconnect();
    });

    it('neutraliza o rótulo de referência que nomeia uma organização', async () => {
      await runSeed();

      const p = await prisma.consentPurpose.findUnique({
        where: { key: 'comunicacao_institucional' },
      });
      expect(p!.label).toBe('Notícias e avisos');
    });

    it('NÃO reescreve o rótulo de uma finalidade que já tem consentimento — ela está em uso', async () => {
      const contact = await prisma.contact.create({
        data: { phoneE164: '+5592977776666', tags: [] },
      });
      await prisma.consentEvent.create({
        data: {
          contactId: contact.id,
          phoneHash: 'hash-do-joao',
          purposeKey: 'comunicacao_institucional',
          action: 'GRANT',
          source: 'WEB_FORM',
          evidenceText: 'Autorizo o IDASAM…',
          consentTextVersion: 'optin-v1',
          occurredAt: new Date('2026-02-01T12:00:00Z'),
        },
      });

      await runSeed();

      const p = await prisma.consentPurpose.findUnique({
        where: { key: 'comunicacao_institucional' },
      });
      expect(p!.label).toBe('Notícias e avisos do IDASAM');
    });

    it('NÃO sobrescreve um rótulo que o operador já editou na tela', async () => {
      await prisma.consentPurpose.update({
        where: { key: 'pesquisa_avaliacao' },
        data: { label: 'Pesquisa de satisfação do CONTINUUM' },
      });

      await runSeed();

      const p = await prisma.consentPurpose.findUnique({
        where: { key: 'pesquisa_avaliacao' },
      });
      expect(p!.label).toBe('Pesquisa de satisfação do CONTINUUM');
    });
  });
});
