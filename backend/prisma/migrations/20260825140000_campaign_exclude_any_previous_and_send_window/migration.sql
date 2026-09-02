-- Pedido do cliente 2026-08-25 — dois booleanos novos em Campaign.
--
-- "excludeAnyPreviousCampaign": "excluir quem já recebeu" só bloqueava quem já
-- estava numa campanha do MESMO template (spec 2026-08-12). Uma campanha nova
-- com template DIFERENTE não excluía ninguém — o que o operador via como "não
-- funciona". DEFAULT false preserva o comportamento de sempre (só o mesmo
-- template) para toda linha já existente; true amplia a rede para QUALQUER
-- campanha anterior.
--
-- "respeitarJanelaDeEnvio": a janela de horário de envio só é aplicada pelo
-- worker a canais DE SESSÃO (unofficial); canais oficiais (hoje só a ZERNIO em
-- produção) nunca a respeitaram. DEFAULT true mantém o comportamento atual
-- onde ela já se aplicava.
--
-- Aditivas e com DEFAULT: nenhuma campanha existente muda de comportamento.
ALTER TABLE "Campaign" ADD COLUMN "excludeAnyPreviousCampaign" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Campaign" ADD COLUMN "respeitarJanelaDeEnvio" BOOLEAN NOT NULL DEFAULT true;
