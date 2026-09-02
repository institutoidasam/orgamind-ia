-- Aditiva: quando o `zernioAccountId` do canal foi conferido contra a lista
-- real de contas do Zernio (`GET /accounts`). NULL = nunca validado — inclusive
-- para todos os canais já existentes, que é a verdade: eles foram criados com
-- o id digitado à mão, sem nenhuma checagem. Um id errado descarta em silêncio
-- todos os webhooks daquela conta (incidente de produção: ~100 mensagens).
-- NB: o model Prisma `Channel` está mapeado (@@map) para a tabela física
-- "WhatsappInstance" — o nome do model mudou, o da tabela não.
ALTER TABLE "WhatsappInstance" ADD COLUMN "zernioAccountVerifiedAt" TIMESTAMP(3);
