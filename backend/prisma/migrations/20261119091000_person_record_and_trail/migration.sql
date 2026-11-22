-- Ficha da pessoa (matrícula e autorização de contato) e trilha de alterações.
-- Aditiva e sem perda de dados: o backfill roda aqui mesmo.

-- CreateEnum
CREATE TYPE "ContactAuthorizationStatus" AS ENUM ('AUTORIZADO', 'NAO_AUTORIZADO');

-- CreateEnum
CREATE TYPE "ContactAuthorizationSource" AS ENUM ('TERMO_ASSINADO', 'FICHA_ADMISSAO', 'ACEITE_WHATSAPP', 'OUTRO', 'CADASTRO_ANTERIOR');

-- CreateEnum
CREATE TYPE "AuditCategory" AS ENUM ('PERSON', 'ASSIGNMENT', 'SCHEDULE', 'STRUCTURE', 'PERMISSIONS');

-- AlterTable
-- A coluna nasce com default AUTORIZADO só para as linhas existentes entrarem
-- autorizadas; o default definitivo (NAO_AUTORIZADO) é fixado logo abaixo.
ALTER TABLE "User" ADD COLUMN     "registration" VARCHAR(30),
ADD COLUMN     "registrationKey" VARCHAR(30),
ADD COLUMN     "contactAuthorization" "ContactAuthorizationStatus" NOT NULL DEFAULT 'AUTORIZADO',
ADD COLUMN     "authorizationSource" "ContactAuthorizationSource",
ADD COLUMN     "authorizationNote" VARCHAR(120),
ADD COLUMN     "authorizationDate" DATE,
ADD COLUMN     "authorizationRecordedById" TEXT,
ADD COLUMN     "authorizationRecordedAt" TIMESTAMP(3);

-- Backfill: toda pessoa existente fica AUTORIZADO, origem CADASTRO_ANTERIOR, sem data
-- nem autor; registrado em = momento da migração.
UPDATE "User" SET "authorizationSource" = 'CADASTRO_ANTERIOR', "authorizationRecordedAt" = NOW();

-- De agora em diante, pessoa criada sem o campo não recebe envio.
ALTER TABLE "User" ALTER COLUMN "contactAuthorization" SET DEFAULT 'NAO_AUTORIZADO';

-- AlterTable
ALTER TABLE "AuditEvent" ADD COLUMN     "subjectUserId" TEXT,
ADD COLUMN     "category" "AuditCategory",
ADD COLUMN     "reason" VARCHAR(200),
ADD COLUMN     "changes" JSONB;

-- Backfill: categoria pelo prefixo da ação (mesma tabela de `categoryOfAction`).
-- Sem correspondência fica nula (campanha, login, canal...). `starts_with`, e não
-- LIKE, porque o `_` de `sector_people.` e `staff_schedule.` é curinga no LIKE.
-- O WHERE evita reescrever os eventos sem categoria (login, campanha), que são a maior parte da tabela.
UPDATE "AuditEvent" SET "category" = CASE
  WHEN starts_with("action", 'user.') THEN 'PERSON'::"AuditCategory"
  WHEN starts_with("action", 'sector_people.') OR starts_with("action", 'assignment.') THEN 'ASSIGNMENT'::"AuditCategory"
  WHEN starts_with("action", 'staff_schedule.') THEN 'SCHEDULE'::"AuditCategory"
  WHEN starts_with("action", 'sector.') OR starts_with("action", 'shift.') OR starts_with("action", 'level.') THEN 'STRUCTURE'::"AuditCategory"
  WHEN starts_with("action", 'permission.') THEN 'PERMISSIONS'::"AuditCategory"
END
WHERE starts_with("action", 'user.')
   OR starts_with("action", 'sector_people.')
   OR starts_with("action", 'assignment.')
   OR starts_with("action", 'staff_schedule.')
   OR starts_with("action", 'sector.')
   OR starts_with("action", 'shift.')
   OR starts_with("action", 'level.')
   OR starts_with("action", 'permission.');

-- Backfill: pessoa do evento. Só evento categorizado: auth.login_success,
-- auth.login_failed, auth.refresh e auth.logout (entity 'User', sem categoria) ficam
-- sem pessoa, senão o histórico da pessoa se enche de refresh (D18).
UPDATE "AuditEvent" SET "subjectUserId" = "entityId" WHERE "entity" = 'User' AND "category" IS NOT NULL;
UPDATE "AuditEvent" SET "subjectUserId" = "metadata"->>'userId'
  WHERE (starts_with("action", 'staff_schedule.') OR "action" = 'sector_people.removed')
    AND "subjectUserId" IS NULL;

-- CreateIndex
CREATE UNIQUE INDEX "User_registrationKey_key" ON "User"("registrationKey");

-- CreateIndex
CREATE INDEX "AuditEvent_subjectUserId_createdAt_idx" ON "AuditEvent"("subjectUserId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditEvent_category_createdAt_idx" ON "AuditEvent"("category", "createdAt");
