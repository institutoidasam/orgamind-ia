# Aceite técnico — módulos internos OrgaMind

Referência anterior: `f3ffcc5dd97d3415d2af69f40f0301854083d822`. Marca OrgaMind, empresa GBR Componentes. Destino autorizado: `https://gbr.picoa.app.br`.

## Escopo entregue

Os oito módulos do protótipo têm rotas e dados persistidos: visão geral, caixa de entrada, nova comunicação, demandas, comunicados, setores, usuários e números e canais. Inclui comentários, histórico, confirmações de leitura, filtros, paginação e quatro papéis com acesso por setor. O cadastro de números distingue registro estrutural de conexão efetiva com um provedor.

## Evidências de validação local

| Verificação | Resultado |
| --- | --- |
| Gate backend das alterações | PASS: 333 testes executados, 15 opt-in ignorados; cobertura das linhas novas 89,8%; lint/Sonar sem achados novos |
| Gate frontend das alterações, snapshot final | PASS: 1.247/1.247 testes; cobertura das linhas novas 82,2%; lint/Sonar sem achados; nenhuma complexidade nova; duplicação 1,5% |
| Suíte completa backend | 4.320 testes executados, 30 opt-in ignorados, nenhuma falha; cobertura de linhas 92,7%, branches 83,2% |
| Suíte nativa completa frontend | 164 arquivos, 1.533 testes, exit 0, nenhum erro não tratado; cobertura de linhas 80,39%, branches 75,42% |
| Integrações adicionais | PostgreSQL real: atribuição concorrente, último administrador, setores e unicidade de telefone; Redis real: 10 cenários de refresh/reuso/revogação/TTL |
| QA HTTP com API real | Nove grupos funcionais, cinco de identidade e dois de refresh aprovados em ambiente isolado |
| Banco isolado | 46 migrações aplicadas, incluindo as três novas migrações aditivas |
| Builds Docker | Backend e frontend aprovados; imagem frontend reconstruída após a última correção de confirmação de leitura |
| QA navegador | Desktop, móvel de 390 px, temas claro/escuro, navegação por teclado, ADMIN/VIEWER, persistência após recarga, comentários e situação de demanda aprovados |

A suíte completa frontend antecede quatro novos casos de aceite e a correção de `isPending` sem item; os testes focados e o gate final das alterações cobrem esse delta. A CI executará novamente as suítes no commit publicado.

## Passivo e limites

Os gates completos não são um PASS global de lint: o legado contém achados anteriores de lint, Sonar e complexidade. Comparação independente não encontrou regressão de produção nesses indicadores. No frontend, lint caiu de 114 erros/12 avisos para 107/8, Sonar de 27 para 25 e complexidade de 301 para 295. No backend, funções extensas adicionais pertencem a testes, excluídos da métrica de produção pelo contrato do gate. Nenhum baseline ou limite foi alterado para absorver regressões. Os testes opt-in ignorados não são contabilizados como executados; as integrações novas afetadas foram executadas separadamente.

Revisões independentes verificaram identidade, ACL, concorrência, refresh, migrações, contratos e frontend. Os achados confirmados foram corrigidos antes do aceite. O CI de drift aceita exclusivamente a tabela auxiliar histórica de quarentena ausente do schema, sem executar seu DROP e sem tolerar outro SQL.

Os dados de QA são sintéticos e exclusivos de um banco isolado. Não entram no seed nem nas imagens de produção. O usuário determinou manter as credenciais atuais; banco, volumes e sal dos consentimentos serão preservados.

## Publicação

Validação local aceita. A integração em main depende da CI do commit; depois será acionado o compose GBR existente e conferidos TLS, saúde, assets novos e leituras autenticadas. O resultado efetivo de produção será registrado no ledger de publicação.
