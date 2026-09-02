-- ── Identidade da organização (singleton por instalação) ─────────────────────
--
-- O orgamind nasceu para uma organização só e carregava o nome dela HARDCODED nos
-- textos que vão para o TITULAR dos dados (texto de consentimento, landing
-- `/opt-in`, wa.me/QR, rótulos das finalidades). Isso não é copy: a Meta exige
-- que o texto de opt-in nomeie o negócio e a LGPD exige controlador determinado
-- (art. 8º). Um titular do cliente A autorizando "a organização B" produz um
-- consentimento incoerente — colhido de gente real.
--
-- Esta migração é ADITIVA: cria a tabela e mais nada. A LINHA é semeada pelo
-- `prisma/seed.ts` (que roda em todo deploy), porque a identidade vem do ENV
-- (`ORG_NAME`, `ORG_LEGAL_NAME`, …) e SQL de migração não lê env. Sem a linha o
-- app não quebra: `OrganizationService.get()` cai no env e, sem env, num
-- fallback NEUTRO — nunca no nome de outro cliente.
CREATE TABLE "Organization" (
  "id"               TEXT NOT NULL DEFAULT 'singleton',
  "name"             TEXT NOT NULL,
  "legalName"        TEXT NOT NULL,
  "privacyPolicyUrl" TEXT,
  "supportContact"   TEXT,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL,

  CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- O QUE ESTA MIGRAÇÃO **NÃO** FAZ, de propósito:
--
--  1. Não reescreve nenhum `ConsentText`. A tabela é versionada e imutável por
--     design: cada `ConsentEvent` aponta para a versão que a pessoa LEU, e é ela
--     que prova o consentimento em 2028 (art. 8º §2º — o ônus é do controlador).
--     Reescrever o corpo apagaria a prova e produziria um registro de que a
--     pessoa leu algo que ela nunca viu. Os textos antigos (que nomeiam o
--     primeiro cliente do sistema) FICAM, e os consentimentos antigos continuam
--     apontando para eles.
--
--     O caminho para colher sob o nome certo é publicar uma versão NOVA:
--       - automático no deploy: `prisma/seed.ts` publica uma versão que nomeia a
--         organização configurada para toda finalidade cujo texto vigente ainda
--         não a nomeia (nunca reescreve, sempre CRIA);
--       - manual: Opt-in → Finalidades → "Texto" (CRUD já existente), que já vem
--         pré-preenchido com a identidade configurada.
--
--  2. Não mexe nos rótulos das finalidades. Também são user-facing (entram no
--     corpo do texto e na landing) e o rótulo de referência nomeava a
--     organização — mas a correção depende do env, então mora no seed, com duas
--     guardas: só reescreve rótulo AINDA IGUAL ao de referência e só em
--     finalidade SEM nenhum ConsentEvent (com consentimento vinculado, ela está
--     em uso e o operador decide pela tela).
