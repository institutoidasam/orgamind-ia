-- Entidade Turno (expand): cria "Shift", semeia os dois turnos legados com ids
-- fixos e copia o enum "WorkShift" para as novas colunas "shiftId". Nada é
-- apagado aqui: as colunas "shift" e o tipo "WorkShift" saem na migração
-- 20261021101000_drop_work_shift_enum (T2b). Horários migrados são valores de
-- partida (o ADMIN confere em Turnos).

-- CreateTable
CREATE TABLE "Shift" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Shift_pkey" PRIMARY KEY ("id")
);

-- Seed: turnos legados FIRST/SECOND
INSERT INTO "Shift" ("id","name","startTime","endTime","isActive","sortOrder","createdAt","updatedAt") VALUES
  ('shift_first','1º turno','06:00','14:00',true,1,now(),now()),
  ('shift_second','2º turno','14:00','22:00',true,2,now(),now());

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "shiftId" TEXT;

-- AlterTable
ALTER TABLE "TeamWhatsappDispatch" ADD COLUMN     "shiftEndTime" TEXT,
ADD COLUMN     "shiftId" TEXT,
ADD COLUMN     "shiftName" TEXT,
ADD COLUMN     "shiftStartTime" TEXT;

-- AlterTable
ALTER TABLE "TeamWhatsappRecipient" ADD COLUMN     "shiftId" TEXT,
ADD COLUMN     "shiftName" TEXT;

-- Backfill: enum WorkShift -> shiftId (+ snapshot de nome/horários no envio)
UPDATE "User" SET "shiftId" = CASE "shift" WHEN 'FIRST' THEN 'shift_first' WHEN 'SECOND' THEN 'shift_second' END WHERE "shift" IS NOT NULL;
UPDATE "TeamWhatsappDispatch" d SET "shiftId" = s."id", "shiftName" = s."name", "shiftStartTime" = s."startTime", "shiftEndTime" = s."endTime"
  FROM "Shift" s WHERE d."shift" IS NOT NULL AND s."id" = CASE d."shift" WHEN 'FIRST' THEN 'shift_first' ELSE 'shift_second' END;
UPDATE "TeamWhatsappRecipient" r SET "shiftId" = s."id", "shiftName" = s."name"
  FROM "Shift" s WHERE r."shift" IS NOT NULL AND s."id" = CASE r."shift" WHEN 'FIRST' THEN 'shift_first' ELSE 'shift_second' END;

-- CreateIndex
CREATE UNIQUE INDEX "Shift_name_key" ON "Shift"("name");

-- CreateIndex
CREATE INDEX "User_shiftId_idx" ON "User"("shiftId");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "Shift"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamWhatsappDispatch" ADD CONSTRAINT "TeamWhatsappDispatch_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "Shift"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamWhatsappRecipient" ADD CONSTRAINT "TeamWhatsappRecipient_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "Shift"("id") ON DELETE SET NULL ON UPDATE CASCADE;
