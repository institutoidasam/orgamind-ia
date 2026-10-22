-- CreateTable
CREATE TABLE "StaffLevel" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StaffLevel_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StaffLevel_name_key" ON "StaffLevel"("name");

-- Dados de partida (C1): ids fixos; ninguém recebe nível na migração.
INSERT INTO "StaffLevel" ("id","name","sortOrder","isActive","createdAt","updatedAt") VALUES
  ('level_coordinator','Coordenador',1,true,now(),now()),
  ('level_leader','Líder',2,true,now(),now()),
  ('level_employee','Funcionário',3,true,now(),now()),
  ('level_operator','Operador',4,true,now(),now());

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "levelId" TEXT;

-- CreateIndex
CREATE INDEX "User_levelId_idx" ON "User"("levelId");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_levelId_fkey" FOREIGN KEY ("levelId") REFERENCES "StaffLevel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
