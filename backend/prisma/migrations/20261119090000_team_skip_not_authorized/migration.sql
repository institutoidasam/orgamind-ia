-- AlterEnum
-- Só o valor novo (no fim do enum): o Postgres não deixa usar um valor de enum na
-- mesma transação em que ele foi criado. Nenhuma migração usa NOT_AUTHORIZED; quem
-- grava o valor é o serviço de envio da equipe.
ALTER TYPE "TeamWhatsappSkipReason" ADD VALUE 'NOT_AUTHORIZED';
