-- "Limitar aos N primeiros contatos" da lista filtrada.
--
-- NULL = sem limite (o comportamento de hoje, e o de toda campanha já existente).
-- Aditiva e anulável de propósito: nenhuma linha existente muda de comportamento.
--
-- Os "N primeiros" são por ORDEM DE CADASTRO (Contact.id asc) — a MESMA ordem que
-- o disparo usa para paginar a audiência. O limite é lido no DISPARO, não só na
-- prévia: um limite que vivesse só na tela deixaria a campanha materializar a
-- base inteira.
ALTER TABLE "Campaign" ADD COLUMN "limit" INTEGER;
