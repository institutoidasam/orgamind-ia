-- Categoria de trilha "Planilhas" (Lote D, exportar pessoas e escala).
-- Migração aditiva: só acrescenta o valor SPREADSHEET ao enum "AuditCategory".
-- Nenhuma tabela é alterada e nenhum dado é tocado.
--
-- O valor novo não é USADO nesta migração: o Postgres não deixa usar um valor
-- de enum na mesma transação que o criou (ADD VALUE dentro de transação é
-- permitido a partir do Postgres 12, desde que o valor não seja usado nela).
-- Quem grava eventos com a categoria entra em migração/deploy posterior.
-- Reaplicar é inofensivo (IF NOT EXISTS).
ALTER TYPE "AuditCategory" ADD VALUE IF NOT EXISTS 'SPREADSHEET';
