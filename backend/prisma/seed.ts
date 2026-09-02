import { PrismaClient, Role } from '@prisma/client';
import argon2 from 'argon2';
import { organizationFromEnv } from '../src/modules/organization/organization-identity';
import {
  composeConsentBody,
  namesOrganization,
  suggestTextVersion,
} from '../src/modules/consent/consent-text.composer';

const prisma = new PrismaClient();

/** id do singleton — ver `OrganizationService.ORGANIZATION_ID`. */
const ORGANIZATION_ID = 'singleton';

export async function runSeed(): Promise<void> {
  const email = process.env.SEED_ADMIN_EMAIL ?? 'admin@picoa.local';
  const password = process.env.SEED_ADMIN_PASSWORD ?? 'changeme123';
  const hash = await argon2.hash(password, { type: argon2.argon2id });

  // IMPORTANT: `update: {}` — do not re-flag mustChangePassword on existing
  // users. The seed runs on every deploy, and re-flagging would force the
  // admin to reset their password on every redeploy, which is what happened
  // in prod (audit log showed admin@picoa.local resetting twice in 15 minutes
  // because each deploy's migrate job called this seed).
  await prisma.user.upsert({
    where: { email },
    update: {},
    create: {
      email,
      password: hash,
      role: Role.ADMIN,
      mustChangePassword: true,
      name: 'Admin',
    },
  });

  const evolutionInstanceName = process.env.EVOLUTION_INSTANCE_NAME ?? 'picoa-dev';
  const apiKey = process.env.EVOLUTION_API_KEY ?? '';

  // Become the default only if no other EVOLUTION row already claims that role.
  // The default is per provider (partial unique index on `(provider) WHERE
  // isDefault`), so a Twilio default must not stop this channel from being the
  // Evolution default — and setting isDefault blindly on every seed run would
  // crash on re-deploy when a previous deploy created a row under a different
  // `evolutionInstanceName` (e.g. env changed between deploys).
  const existingDefault = await prisma.channel.findFirst({
    where: { isDefault: true, provider: 'EVOLUTION' },
    select: { id: true, evolutionInstanceName: true },
  });
  const isDefault = !existingDefault || existingDefault.evolutionInstanceName === evolutionInstanceName;

  // This creates the app-side row only — it does NOT create the instance on the
  // Evolution side. That's intentional: the matching Evolution instance is
  // provisioned lazily the first time an operator opens "Conectar" for it (the
  // QR endpoint calls EvolutionApiAdapter.ensureProvisioned). Until then the
  // row is a valid default for campaigns but has no live WhatsApp session.
  await prisma.channel.upsert({
    where: { evolutionInstanceName },
    update: {},
    create: {
      name: 'Atendimento',
      evolutionInstanceName,
      apiKey,
      isDefault,
      isActive: true,
    },
  });

  const org = await seedOrganization();
  await normalizeReferencePurposes();
  const published = await ensureConsentTextsNameOrganization();

  console.log(
    `Seed ok: admin=${email}, instance=${evolutionInstanceName} (default=${isDefault}), ` +
      `org=${org.name}, textos de consentimento publicados=${published}`,
  );
}

// ── Identidade da organização ────────────────────────────────────────────────

/**
 * O singleton `Organization`, semeado do env — a identidade que vai para o
 * TITULAR dos dados (texto de consentimento, landing `/opt-in`, wa.me/QR).
 *
 * `update: {}` é o ponto: o seed roda em TODO deploy, e a tela de Configurações
 * é a fonte da verdade depois do primeiro boot. Sobrescrever aqui desfaria, a
 * cada redeploy, a razão social que o operador conferiu contra o CNPJ.
 */
async function seedOrganization() {
  const identity = organizationFromEnv(process.env);

  return prisma.organization.upsert({
    where: { id: ORGANIZATION_ID },
    update: {},
    create: { id: ORGANIZATION_ID, ...identity },
  });
}

// ── Finalidades: rótulos NEUTROS (o titular também os lê) ────────────────────

/**
 * Os rótulos de referência nasceram na migração `20260711120000_consent_core`
 * com o vocabulário (e o nome) de uma ONG específica. O rótulo NÃO é decoração:
 * ele entra no corpo do texto que o titular lê ("…mensagens no WhatsApp sobre
 * {rótulo}") e aparece na landing. Um rótulo que nomeia a ONG antiga num deploy
 * de outro cliente é o mesmo bug do texto, só que mais escondido.
 *
 * ⚠️ O literal em `was:` abaixo é a REGRA, não sujeira: é ele que reconhece o
 * rótulo antigo para poder renomeá-lo. Apagá-lo NÃO remove o nome antigo —
 * CONGELA-O para sempre em qualquer instalação que ainda o tenha.
 *
 * A correção é conservadora — duas guardas, e as duas importam:
 *
 *  1. só reescreve rótulo AINDA IDÊNTICO ao de referência (se o operador já
 *     editou pela tela, a escolha dele vence — o seed não briga com ele);
 *  2. só em finalidade SEM NENHUM `ConsentEvent`. Com consentimento vinculado, a
 *     finalidade está em uso: quem decide o que fazer com ela é o operador (pela
 *     tela: desativar, ou criar a dele). O orgamind não mexe.
 *
 * Os rótulos novos são neutros de organização E de vocabulário: nada de
 * "instituto", "projeto" ou nome de ONG. `captacao_recursos` continua sendo o que a
 * chave diz (a chave é imutável — ela vive dentro de cada consentimento colhido);
 * quem não faz captação desativa a finalidade na tela, um clique.
 */
const REFERENCE_PURPOSES: Record<
  string,
  { was: string; label: string; description: string }
> = {
  comunicacao_institucional: {
    was: 'Notícias e avisos do IDASAM',
    label: 'Notícias e avisos',
    description: 'Comunicados gerais e novidades da organização.',
  },
  convite_atividades: {
    was: 'Convites para cursos, oficinas e eventos',
    label: 'Convites para eventos, cursos e atividades',
    description: 'Inscrições, chamadas e convites.',
  },
  pesquisa_avaliacao: {
    was: 'Pesquisas e avaliações',
    label: 'Pesquisas e avaliações',
    description: 'Pesquisas de satisfação e avaliações de atendimento.',
  },
  captacao_recursos: {
    was: 'Campanhas de doação e apoio',
    label: 'Campanhas de doação e apoio',
    description:
      'Arrecadação de recursos. Desative esta finalidade se ela não se aplica ao seu negócio.',
  },
  servico_projeto: {
    was: 'Avisos operacionais do projeto em que participo',
    label: 'Avisos operacionais do serviço em que participo',
    description:
      'Utility: data, local e mudanças das atividades que a pessoa contratou/participa.',
  },
};

async function normalizeReferencePurposes(): Promise<void> {
  for (const [key, ref] of Object.entries(REFERENCE_PURPOSES)) {
    const purpose = await prisma.consentPurpose.findUnique({
      where: { key },
      select: { key: true, label: true },
    });
    // Guarda 1 — rótulo já customizado pelo operador: não é nosso.
    if (!purpose || purpose.label !== ref.was) continue;

    // Guarda 2 — finalidade EM USO: há consentimento vinculado a ela.
    const events = await prisma.consentEvent.count({ where: { purposeKey: key } });
    if (events > 0) continue;

    if (ref.label === ref.was) {
      // Rótulo já era neutro; só a descrição (operator-facing) se atualiza.
      await prisma.consentPurpose.update({
        where: { key },
        data: { description: ref.description },
      });
      continue;
    }

    await prisma.consentPurpose.update({
      where: { key },
      data: { label: ref.label, description: ref.description },
    });
    console.log(`  finalidade ${key}: rótulo neutralizado → "${ref.label}"`);
  }
}

// ── Texto de consentimento com a organização CERTA ───────────────────────────

/** Utility (avisos operacionais) não promete cadência — sem frase de frequência. */
const UTILITY_PURPOSES = new Set(['servico_projeto']);

/**
 * Garante que toda finalidade ATIVA tem um texto vigente que NOMEIA esta
 * organização. Onde não tem, PUBLICA UMA VERSÃO NOVA — nunca reescreve.
 *
 * É a diferença entre corrigir e falsificar. `ConsentText` é versionado e
 * imutável por design: cada `ConsentEvent` aponta para a versão que a pessoa
 * LEU, e é ela que prova o consentimento (art. 8º §2º — o ônus é do
 * controlador). Reescrever o corpo produziria um registro de que a pessoa leu
 * algo que nunca viu. Então os textos antigos ficam, os consentimentos antigos
 * seguem apontando para eles, e o que passa a valer daqui para a frente é a
 * versão nova.
 *
 * Idempotente pelo conteúdo, não por um marcador: uma vez que exista texto
 * vigente nomeando a organização (semeado OU escrito à mão pelo operador na
 * tela), o seed não publica mais nada. Trocar a razão social em Configurações
 * faz o próximo deploy publicar a versão correspondente — que é exatamente o que
 * deve acontecer.
 */
async function ensureConsentTextsNameOrganization(): Promise<number> {
  const org = await prisma.organization.findUniqueOrThrow({
    where: { id: ORGANIZATION_ID },
  });

  const purposes = await prisma.consentPurpose.findMany({
    where: { active: true },
    include: { texts: { orderBy: { activeFrom: 'desc' } } },
  });

  let published = 0;
  const now = Date.now();

  for (const purpose of purposes) {
    const vigente = purpose.texts.find((t) => t.activeFrom.getTime() <= now);
    if (vigente && namesOrganization(vigente.body, org)) continue;

    const version = suggestTextVersion(
      org,
      purpose.texts.map((t) => t.version),
    );
    const body = composeConsentBody(
      org,
      { label: purpose.label },
      UTILITY_PURPOSES.has(purpose.key) ? { messagesPerMonth: null } : {},
    );

    await prisma.consentText.create({
      data: { purposeKey: purpose.key, version, body },
    });
    published += 1;
    console.log(
      `  finalidade ${purpose.key}: texto ${version} publicado (as versões anteriores permanecem — são a prova do que a pessoa leu)`,
    );
  }

  return published;
}

// CLI entrypoint preserved
if (import.meta.url === `file://${process.argv[1]}`) {
  runSeed()
    .catch((e) => {
      console.error(e);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
}
