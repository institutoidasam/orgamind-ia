-- AlterTable
ALTER TABLE "User" ADD COLUMN     "hasAccess" BOOLEAN NOT NULL DEFAULT true,
ALTER COLUMN "email" DROP NOT NULL,
ALTER COLUMN "password" DROP NOT NULL;

-- Pessoa sem acesso (D1): sem e-mail e sem senha. Quem tem acesso continua com
-- os dois. Usuários existentes ficam com hasAccess = true (default) e já têm
-- e-mail e senha, então o CHECK vale para todos. O Prisma não modela CHECK:
-- o diff do schema não o enxerga.
ALTER TABLE "User" ADD CONSTRAINT "User_access_consistent" CHECK (
  ("hasAccess" AND "email" IS NOT NULL AND "password" IS NOT NULL)
  OR (NOT "hasAccess" AND "email" IS NULL AND "password" IS NULL)
);
