-- AlterTable
ALTER TABLE "Sector" ADD COLUMN     "channelId" TEXT;

-- CreateIndex
CREATE INDEX "Sector_channelId_idx" ON "Sector"("channelId");

-- AddForeignKey
ALTER TABLE "Sector" ADD CONSTRAINT "Sector_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "WhatsappInstance"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Associação das áreas ativas a um número (spec §9). Só preenche "Sector"."channelId"
-- que está vazio; nada é apagado nem reescrito. Elegível = canal ativo, provedor
-- GOZAP ou EVOLUTION (TWILIO/ZERNIO/META nunca contam, mesmo como padrão).
-- Áreas inativas e áreas criadas depois ficam sem número.

-- 1. Cadastro existente: a área com um SectorNumber ligado a canal elegível usa esse
--    canal. Com mais de um, vale o padrão; sem padrão, o canal mais antigo.
UPDATE "Sector" s SET "channelId" = pick."channelId"
  FROM (
    SELECT DISTINCT ON (n."sectorId") n."sectorId", c."id" AS "channelId"
    FROM "SectorNumber" n
    JOIN "WhatsappInstance" c ON c."id" = n."channelId"
    WHERE n."sectorId" IS NOT NULL
      AND c."isActive" AND c."provider" IN ('GOZAP', 'EVOLUTION')
    ORDER BY n."sectorId", c."isDefault" DESC, c."createdAt" ASC, c."id" ASC
  ) pick
  WHERE s."id" = pick."sectorId" AND s."isActive" AND s."channelId" IS NULL;

-- 2. As demais vão para o canal padrão, se for elegível (o padrão é por provedor:
--    com dois padrões elegíveis, o mais antigo).
UPDATE "Sector" s SET "channelId" = d."id"
  FROM (
    SELECT c."id" FROM "WhatsappInstance" c
    WHERE c."isDefault" AND c."isActive" AND c."provider" IN ('GOZAP', 'EVOLUTION')
    ORDER BY c."createdAt" ASC, c."id" ASC
    LIMIT 1
  ) d
  WHERE s."isActive" AND s."channelId" IS NULL;

-- 3. Sem padrão elegível, as demais vão para o único canal elegível.
UPDATE "Sector" s SET "channelId" = o."id"
  FROM (
    SELECT min(c."id") AS "id" FROM "WhatsappInstance" c
    WHERE c."isActive" AND c."provider" IN ('GOZAP', 'EVOLUTION')
    HAVING count(*) = 1
  ) o
  WHERE s."isActive" AND s."channelId" IS NULL;

-- 4. Mais de um elegível e nenhum padrão elegível: as demais ficam sem número
--    (nenhum comando; os avisos da tela cobrem).
