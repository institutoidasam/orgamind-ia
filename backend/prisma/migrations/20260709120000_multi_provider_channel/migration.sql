CREATE TYPE "ChannelProvider" AS ENUM ('EVOLUTION', 'TWILIO', 'ZERNIO', 'META');
ALTER TABLE "WhatsappInstance"
  ADD COLUMN "provider" "ChannelProvider" NOT NULL DEFAULT 'EVOLUTION',
  ADD COLUMN "twilioMessagingServiceSid" TEXT,
  ADD COLUMN "zernioAccountId" TEXT,
  ALTER COLUMN "evolutionInstanceName" DROP NOT NULL,
  ALTER COLUMN "apiKey" DROP NOT NULL;
CREATE UNIQUE INDEX "WhatsappInstance_zernioAccountId_key" ON "WhatsappInstance"("zernioAccountId");
CREATE INDEX "WhatsappInstance_provider_isActive_idx" ON "WhatsappInstance"("provider", "isActive");
-- At most ONE default channel per provider, enforced at the DB level. Prisma
-- can't model partial unique indexes, so this lives only here: it closes the
-- setDefault race where two concurrent calls on DIFFERENT channels of the same
-- provider could both end up isDefault=true (the clear-then-set transaction
-- pattern alone can't prevent that).
CREATE UNIQUE INDEX "WhatsappInstance_provider_default_key" ON "WhatsappInstance"("provider") WHERE "isDefault";
ALTER TABLE "Template" ADD COLUMN "provider" "ChannelProvider" NOT NULL DEFAULT 'EVOLUTION';
UPDATE "Template" SET "provider" = 'TWILIO' WHERE "twilioContentSid" IS NOT NULL;
