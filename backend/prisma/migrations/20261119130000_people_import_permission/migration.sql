-- Permissão pessoas.importar (Lote E, spec "Permissões"). Só semeia a chave nova
-- negada para os dois papéis editáveis; nenhuma tabela é alterada e nenhum dado
-- é apagado. ADMIN (todas) e VIEWER (nenhuma) não têm linha: são fixos em código.
--
-- `updatedById` nulo (feito pela migração). ON CONFLICT DO NOTHING: reaplicar
-- nunca desfaz uma linha editada pela tela.
INSERT INTO "RolePermission" ("role","key","granted") VALUES
  ('SUPERVISOR','pessoas.importar',false),
  ('OPERATOR','pessoas.importar',false)
ON CONFLICT DO NOTHING;
