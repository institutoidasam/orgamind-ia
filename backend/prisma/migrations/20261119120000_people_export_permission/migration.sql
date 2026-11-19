-- Permissão pessoas.exportar (Lote D, spec "Permissões"). Só semeia a chave nova
-- negada para os dois papéis editáveis; nenhuma tabela é alterada e nenhum dado
-- é apagado. ADMIN (todas) e VIEWER (nenhuma) não têm linha: são fixos em código.
--
-- `updatedById` nulo (feito pela migração). ON CONFLICT DO NOTHING: reaplicar
-- nunca desfaz uma linha editada pela tela.
INSERT INTO "RolePermission" ("role","key","granted") VALUES
  ('SUPERVISOR','pessoas.exportar',false),
  ('OPERATOR','pessoas.exportar',false)
ON CONFLICT DO NOTHING;
