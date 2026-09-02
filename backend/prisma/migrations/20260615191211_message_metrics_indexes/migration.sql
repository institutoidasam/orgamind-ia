-- CreateIndex
CREATE INDEX "Message_queuedAt_idx" ON "Message"("queuedAt");

-- CreateIndex
CREATE INDEX "Message_status_queuedAt_idx" ON "Message"("status", "queuedAt");
