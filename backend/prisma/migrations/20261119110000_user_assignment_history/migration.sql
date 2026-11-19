-- Histórico de vínculo da pessoa (Lote C, DV1 a DV4). Só cria a tabela e insere
-- uma linha aberta por pessoa com os valores atuais da ficha; nenhuma tabela
-- existente é alterada e nenhum dado é apagado. O DDL abaixo é o que o
-- `prisma migrate diff` gera para o modelo `UserAssignment` (sem o DROP da
-- quarentena `_message_dup_neutralized_20260819`, que o drift do CI tolera).

-- Os ADD CONSTRAINT ... FOREIGN KEY abaixo travam "User", "Sector", "Shift" e
-- "StaffLevel" e entram na fila atrás de qualquer transação aberta nelas; sem
-- limite o deploy ficaria pendurado. Se estourar, a migração inteira se desfaz
-- (nada escrito): rode `prisma migrate resolve --rolled-back` e aplique de novo.
-- SET LOCAL: vale só nesta transação.
SET LOCAL lock_timeout = '15s';

-- CreateTable
CREATE TABLE "UserAssignment" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sectorId" TEXT,
    "shiftId" TEXT,
    "levelId" TEXT,
    "validFrom" DATE,
    "validTo" DATE,
    "recordedById" TEXT,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UserAssignment_userId_validFrom_idx" ON "UserAssignment"("userId", "validFrom");

-- CreateIndex
CREATE INDEX "UserAssignment_sectorId_validFrom_validTo_idx" ON "UserAssignment"("sectorId", "validFrom", "validTo");

-- CreateIndex
CREATE INDEX "UserAssignment_shiftId_idx" ON "UserAssignment"("shiftId");

-- CreateIndex
CREATE INDEX "UserAssignment_levelId_idx" ON "UserAssignment"("levelId");

-- AddForeignKey
ALTER TABLE "UserAssignment" ADD CONSTRAINT "UserAssignment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserAssignment" ADD CONSTRAINT "UserAssignment_sectorId_fkey" FOREIGN KEY ("sectorId") REFERENCES "Sector"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserAssignment" ADD CONSTRAINT "UserAssignment_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "Shift"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserAssignment" ADD CONSTRAINT "UserAssignment_levelId_fkey" FOREIGN KEY ("levelId") REFERENCES "StaffLevel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Garantias só no SQL (DV2): o Prisma não modela índice único parcial nem CHECK,
-- então o `prisma migrate diff` não os enxerga. Um diff gerado depois pode trazer
-- DROP deles: apague a linha (mesmo padrão de "WhatsappInstance_provider_default_key").
-- No máximo uma linha aberta (sem fim) por pessoa.
CREATE UNIQUE INDEX "UserAssignment_userId_open_key" ON "UserAssignment"("userId") WHERE "validTo" IS NULL;

-- Início nunca depois do fim; início nulo (anterior ao histórico) e fim nulo
-- (linha aberta) passam.
ALTER TABLE "UserAssignment" ADD CONSTRAINT "UserAssignment_period_check" CHECK (
  "validFrom" IS NULL OR "validTo" IS NULL OR "validFrom" <= "validTo"
);

-- backfill:begin
-- Uma linha aberta por pessoa (ativas e inativas, com e sem setor, com e sem
-- acesso), com setor, turno e nível da ficha, início e fim nulos e
-- `recordedById` nulo (feito pela migração). Reexecutável: só para quem ainda
-- não tem linha aberta, e o id determinístico não duplica.
INSERT INTO "UserAssignment" (
  "id", "userId", "sectorId", "shiftId", "levelId",
  "validFrom", "validTo", "recordedById", "recordedAt"
)
SELECT
  'ua_' || u."id", u."id", u."sectorId", u."shiftId", u."levelId",
  NULL, NULL, NULL, now()
FROM "User" u
WHERE NOT EXISTS (
  SELECT 1 FROM "UserAssignment" a
  WHERE a."userId" = u."id" AND a."validTo" IS NULL
)
ON CONFLICT ("id") DO NOTHING;

-- Conferência (aceite 18): toda pessoa com uma linha aberta igual à ficha. Se
-- não, o RAISE aborta a migração com as duas contagens.
DO $$
DECLARE
  missing_open integer;
  diverging_open integer;
BEGIN
  SELECT count(*) INTO missing_open
  FROM "User" u
  WHERE NOT EXISTS (
    SELECT 1 FROM "UserAssignment" a
    WHERE a."userId" = u."id" AND a."validTo" IS NULL
  );

  SELECT count(*) INTO diverging_open
  FROM "UserAssignment" a
  JOIN "User" u ON u."id" = a."userId"
  WHERE a."validTo" IS NULL
    AND (
      a."sectorId" IS DISTINCT FROM u."sectorId"
      OR a."shiftId" IS DISTINCT FROM u."shiftId"
      OR a."levelId" IS DISTINCT FROM u."levelId"
    );

  IF missing_open > 0 OR diverging_open > 0 THEN
    RAISE EXCEPTION
      'UserAssignment backfill: pessoas sem linha aberta = %, linhas abertas diferentes da ficha = %',
      missing_open, diverging_open;
  END IF;
END
$$;
-- backfill:end
