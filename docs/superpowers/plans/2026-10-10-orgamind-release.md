# Publicação dos módulos internos OrgaMind

Destino autorizado: `https://gbr.picoa.app.br`, projeto Dokploy **OrgaMind GBR**, compose `wbMTHjY2-EfyRC_rKcDaL`, origem Git main. Publicação autorizada explicitamente pelo usuário nesta sessão.

## Antes da publicação

- Aceitar os oito módulos da spec funcional, com revisão independente e QA em API/banco isolados.
- Gates changed e final por stack comparados ao baseline f3ffcc5. Corrigir todas as regressões novas; passivo anterior deve ser registrado separadamente.
- Build das imagens backend e frontend; aplicar as três migrações aditivas no banco de teste. Nenhuma fixture de QA entra na imagem ou no seed de produção.
- Preservar as alterações locais da main que não pertencem à feature; publicar somente o resultado aceito contra origin/main.
- Preservar volumes nomeados, banco e sal dos consentimentos; não usar freshVolumes nem recriar projeto/domínio. Credenciais atuais são lidas exclusivamente pelo wrapper existente. O usuário confirmou manter as credenciais de acesso atuais; não executar rotação.

## Publicação e verificação

- Commit e push da feature; integrar em main após checks necessários e sem incluir mudanças alheias.
- Acionar deploy do compose existente com o commit final identificado.
- Acompanhar o job de migração e estado de api/worker/web; coletar resultado e logs com acesso restrito.
- Confirmar TLS, health live/ready, assets/frontend novo, autenticação e leituras dos módulos no destino público. Não criar dados demonstrativos em produção nem alterar senha pelo navegador.

## Recuperação

Se migração ou serviço falhar, interromper aceite e diagnosticar a causa. As migrações são aditivas: não apagar tabelas/colunas, não resetar o banco. Para falha de build/runtime imediata, a referência anterior é `f3ffcc5dd97d3415d2af69f40f0301854083d822`; preferir correção e redeploy, pois versões antigas não conhecem os papéis internos novos. Preservar todo dado gravado após a publicação e conferir compatibilidade antes de qualquer rollback de código.

Status inicial: preparação em andamento, sem publicação desta feature.
