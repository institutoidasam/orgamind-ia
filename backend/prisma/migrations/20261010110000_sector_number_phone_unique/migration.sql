-- Enforce the normalized E.164 identity used by the internal numbers contract.
CREATE UNIQUE INDEX "SectorNumber_phone_key" ON "SectorNumber"("phone");
