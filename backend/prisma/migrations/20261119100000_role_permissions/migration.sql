-- Permissões por papel (DB1/DB18). Só cria a tabela e semeia a matriz inicial
-- (spec B2); nenhuma tabela existente é tocada e nenhum dado é apagado.

-- CreateTable
CREATE TABLE "RolePermission" (
    "role" "Role" NOT NULL,
    "key" VARCHAR(64) NOT NULL,
    "granted" BOOLEAN NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedById" TEXT,

    CONSTRAINT "RolePermission_pkey" PRIMARY KEY ("role","key"),
    -- ADMIN (todas) e VIEWER (nenhuma) são fixos em código: o banco não aceita linha deles.
    CONSTRAINT "RolePermission_role_editable_check" CHECK ("role" IN ('SUPERVISOR','OPERATOR'))
);

-- Matriz inicial: 2 papéis x 8 chaves, `updatedById` nulo (feito pela migração).
-- ON CONFLICT DO NOTHING: reaplicar nunca desfaz uma linha editada.
INSERT INTO "RolePermission" ("role","key","granted") VALUES
  ('SUPERVISOR','pessoas.editar',true),
  ('SUPERVISOR','pessoas.inativar',true),
  ('SUPERVISOR','escala.alterar',true),
  ('SUPERVISOR','estrutura.manter',false),
  ('SUPERVISOR','telefone.ver_completo',true),
  ('SUPERVISOR','equipe.enviar',true),
  ('SUPERVISOR','equipe.disparo_amplo',true),
  ('SUPERVISOR','trilha.consultar',true),
  ('OPERATOR','pessoas.editar',true),
  ('OPERATOR','pessoas.inativar',false),
  ('OPERATOR','escala.alterar',true),
  ('OPERATOR','estrutura.manter',false),
  ('OPERATOR','telefone.ver_completo',true),
  ('OPERATOR','equipe.enviar',true),
  ('OPERATOR','equipe.disparo_amplo',true),
  ('OPERATOR','trilha.consultar',false)
ON CONFLICT DO NOTHING;
