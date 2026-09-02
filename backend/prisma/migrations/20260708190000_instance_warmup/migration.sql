-- Anti-ban warm-up ramp: track when a number was paired so the daily send cap
-- can ramp up by age.
ALTER TABLE "WhatsappInstance" ADD COLUMN "warmupStartedAt" TIMESTAMP(3);

-- Currently-paired numbers: start a fresh warm-up on deploy. We don't know their
-- true pairing age, so be conservative (a live number just got re-paired). Safe
-- and idempotent.
UPDATE "WhatsappInstance"
SET "warmupStartedAt" = now()
WHERE "isActive" = true AND "phoneE164" IS NOT NULL AND "warmupStartedAt" IS NULL;
