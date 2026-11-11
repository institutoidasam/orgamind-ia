-- AlterEnum
-- Só os valores novos (no fim do enum): o Postgres não deixa usar um valor de enum
-- na mesma transação em que ele foi criado. O uso (FAILED incerto -> UNCERTAIN) fica
-- na migração seguinte (20261110092000_team_recipient_tracking).
ALTER TYPE "TeamWhatsappRecipientStatus" ADD VALUE 'DELIVERED';
ALTER TYPE "TeamWhatsappRecipientStatus" ADD VALUE 'READ';
ALTER TYPE "TeamWhatsappRecipientStatus" ADD VALUE 'REPLIED';
ALTER TYPE "TeamWhatsappRecipientStatus" ADD VALUE 'UNCERTAIN';
