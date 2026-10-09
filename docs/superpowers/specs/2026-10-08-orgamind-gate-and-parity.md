# OrgaMind — validação real, gate completo e paridade Picoa

## Objetivo

Validar o rebrand contra a API real em ambiente local isolado, eliminar as falhas do gate completo do frontend sem reduzir suas exigências e identificar/implementar as melhorias funcionais do Picoa que faltam no OrgaMind. O deploy foi explicitamente cancelado pelo usuário na ausência de um alvo existente.

## Contratos

- Preservar fluxos de campanhas, consentimento, WhatsApp e dados existentes. Testes de integração não devem enviar mensagens reais nem usar credenciais em logs.
- Baseline de análise: `f4abdb9` para esta rodada; o gate completo anterior já falhava em `5a37735`. Não ocultar regressões por variação do total agregado.
- Cada correção tem teste funcional quando altera comportamento, typecheck/build e gate dos arquivos alterados. O fechamento exige gate completo realmente PASS: lint, Sonar, complexidade, testes, cobertura e duplicação.
- Comparação com Picoa usa achados com evidência, impacto e aceite específico; não portar código apenas por semelhança nominal.
- O usuário confirmou banco OrgaMind novo, sem dados do Picoa. Ainda assim, migração, API e worker de produção devem exigir o mesmo `PICOA_CONSENT_SALT` externo para que hashes de consentimento sejam estáveis entre serviços; o valor real não entra no repositório.

## Aceite

1. Login, dashboard e rotas principais funcionam com API e banco locais reais, em projeto Docker isolado, sem provedores externos de mensagens.
2. Gate completo do frontend PASS sem alterar limiares, regras ou baseline.
3. Backlog de paridade Picoa auditado; melhorias faltantes implementadas e validadas por tasks delimitadas, ou lacunas técnicas explicitamente comprovadas.
4. Nenhum deploy sem alvo existente, conforme instrução do usuário.
