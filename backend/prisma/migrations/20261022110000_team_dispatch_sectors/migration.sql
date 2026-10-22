-- AlterTable
ALTER TABLE "TeamWhatsappRecipient" ADD COLUMN     "levelName" TEXT,
ADD COLUMN     "sectorId" TEXT,
ADD COLUMN     "sectorName" TEXT;

-- CreateTable
CREATE TABLE "TeamWhatsappDispatchSector" (
    "dispatchId" TEXT NOT NULL,
    "sectorId" TEXT NOT NULL,
    "sectorName" TEXT NOT NULL,

    CONSTRAINT "TeamWhatsappDispatchSector_pkey" PRIMARY KEY ("dispatchId","sectorId")
);

-- CreateIndex
CREATE INDEX "TeamWhatsappDispatchSector_sectorId_idx" ON "TeamWhatsappDispatchSector"("sectorId");

-- AddForeignKey
ALTER TABLE "TeamWhatsappDispatchSector" ADD CONSTRAINT "TeamWhatsappDispatchSector_dispatchId_fkey" FOREIGN KEY ("dispatchId") REFERENCES "TeamWhatsappDispatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Backfill (D5): uma linha por envio a setor existente, com o nome atual do
-- setor ou, se o setor sumiu, o começo do rótulo; alvo pessoa não ganha linha.
-- Os destinatários desses envios recebem o setor do envio; levelName fica null
-- (envio anterior ao nível). Nada é apagado nem reescrito além das colunas novas.
INSERT INTO "TeamWhatsappDispatchSector" ("dispatchId","sectorId","sectorName")
  SELECT d."id", d."targetId", COALESCE(s."name", split_part(d."targetLabel", ' · ', 1))
  FROM "TeamWhatsappDispatch" d LEFT JOIN "Sector" s ON s."id" = d."targetId"
  WHERE d."targetType" = 'SECTOR';
UPDATE "TeamWhatsappRecipient" r SET "sectorId" = ds."sectorId", "sectorName" = ds."sectorName"
  FROM "TeamWhatsappDispatchSector" ds
  WHERE r."dispatchId" = ds."dispatchId";
