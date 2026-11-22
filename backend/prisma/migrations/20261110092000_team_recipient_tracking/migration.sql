-- AlterTable
ALTER TABLE "TeamWhatsappRecipient" ADD COLUMN     "acceptedAt" TIMESTAMP(3),
ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "channelId" TEXT,
ADD COLUMN     "channelName" TEXT,
ADD COLUMN     "channelPhoneE164" TEXT,
ADD COLUMN     "contactId" TEXT,
ADD COLUMN     "deliveredAt" TIMESTAMP(3),
ADD COLUMN     "manualRetries" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "readAt" TIMESTAMP(3),
ADD COLUMN     "repliedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "TeamWhatsappRecipient_messageId_idx" ON "TeamWhatsappRecipient"("messageId");

-- CreateIndex
CREATE INDEX "TeamWhatsappRecipient_channelId_contactId_acceptedAt_idx" ON "TeamWhatsappRecipient"("channelId", "contactId", "acceptedAt");

-- AddForeignKey
ALTER TABLE "TeamWhatsappRecipient" ADD CONSTRAINT "TeamWhatsappRecipient_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "WhatsappInstance"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Backfill do histórico (D3, D5, D11). Só preenche colunas novas e muda o status de
-- FAILED incerto para UNCERTAIN; o errorCode e as demais colunas ficam como estão.

-- D3: o canal do envio (null se o envio já está sem canal), com nome e telefone.
UPDATE "TeamWhatsappRecipient" r
  SET "channelId" = c."id", "channelName" = c."name", "channelPhoneE164" = c."phoneE164"
  FROM "TeamWhatsappDispatch" d
  JOIN "WhatsappInstance" c ON c."id" = d."channelId"
  WHERE r."dispatchId" = d."id";

-- D11: o contato vem da Message do destinatário; D6: SENT foi aceito quando a
-- Message saiu (sentAt). Só SENT ganha acceptedAt: os demais não foram aceitos.
UPDATE "TeamWhatsappRecipient" r
  SET "contactId" = m."contactId",
      "acceptedAt" = CASE WHEN r."status" = 'SENT' THEN m."sentAt" END
  FROM "Message" m
  WHERE r."messageId" = m."id";

-- D5: FAILED com código incerto (a mensagem pode ter saído) -> UNCERTAIN. Os literais
-- vêm de TEAM_NEVER_REDISPATCH_CODES (chat.service.ts) + o indeterminate do envio
-- e qualquer *.timeout. Os demais FAILED (inclusive sem código) ficam como estão.
UPDATE "TeamWhatsappRecipient" SET "status" = 'UNCERTAIN'
  WHERE "status" = 'FAILED'
    AND ("errorCode" IN ('team_whatsapp.indeterminate', 'gozap.timeout', 'zernio.timeout',
                         'twilio.timeout', 'evolution.timeout', 'evolution.unknown',
                         'sending_stuck')
         OR "errorCode" LIKE '%.timeout');
