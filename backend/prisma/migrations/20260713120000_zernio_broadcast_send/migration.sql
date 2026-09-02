-- ZB — o caminho de ESCRITA do broadcast do Zernio.
--
-- Hoje a campanha do orgamind sai 1-a-1 (`POST /inbox/conversations`, UMA chamada por
-- pessoa) e por isso NADA aparece no painel do Zernio. Esta migração é a base para
-- o orgamind criar um BROADCAST DE VERDADE lá.
--
-- ADITIVA e SEGURA COM A VERSÃO ANTERIOR NO AR:
--   * as duas colunas de Channel nascem com DEFAULT, e o default de
--     `zernioBroadcastEnabled` é FALSE — ou seja, NENHUM canal muda de
--     comportamento por causa desta migração. O 1-a-1 continua sendo o padrão até
--     alguém LIGAR a chave num canal, de propósito;
--   * `Message.zernioBroadcastId` é NULLABLE e nasce NULL em todas as linhas
--     existentes (elas saíram pelo 1-a-1 — o que é a verdade).
--
-- Nota de FK: o model `Channel` do Prisma tem `@@map("WhatsappInstance")` — a
-- tabela REAL se chama WhatsappInstance. Referenciar "Channel" aqui quebraria a
-- migração (foi exatamente o erro corrigido em 9a6397b).

-- AlterTable: a chave do broadcast, POR CANAL.
ALTER TABLE "WhatsappInstance"
  ADD COLUMN "zernioBroadcastEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "zernioBroadcastChunk" INTEGER NOT NULL DEFAULT 50;

-- AlterTable: qual disparo do Zernio carregou esta mensagem (NULL = 1-a-1).
ALTER TABLE "Message" ADD COLUMN "zernioBroadcastId" TEXT;

-- CreateIndex: o polling varre "as mensagens deste disparo" e o kill-switch varre
-- "os disparos vivos desta campanha". Sem índice, cada tick é um seq scan na
-- tabela mais quente do banco.
CREATE INDEX "Message_zernioBroadcastId_idx" ON "Message"("zernioBroadcastId");

-- AddForeignKey: SetNull — apagar o espelho de um disparo NÃO pode apagar a
-- Message. A Message é a prova de que a pessoa recebeu (ou de que o gate a
-- recusou); num processo do TSE, é a defesa do cliente.
ALTER TABLE "Message"
  ADD CONSTRAINT "Message_zernioBroadcastId_fkey"
  FOREIGN KEY ("zernioBroadcastId") REFERENCES "ZernioBroadcast"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
