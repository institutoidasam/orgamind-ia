# OrgaMind — refinamento fiel ao protótipo

## Pedido, referência e baseline

O usuário pediu melhorar o frontend e corrigir detalhes/nome desalinhados com `/home/andre-lima/Downloads/OrgaMind-Prototipo.html`. Confirmou explicitamente **exibir GBR Componentes como empresa no painel**. Marca exata: **OrgaMind**. Reutilizar specs/ledgers rebrand08/10 e parity/deploy09/10; este documento complementa contratos visuais anteriores.

Base Git f3ffcc5, checkout limpo antes de alterações. Baseline real `gate --path frontend` exit1:1452/1452 testes; lint114erros/12avisos, Sonar preexistente, complexidade301, cobertura79,8%linhas/76,4%branches. Saída completa /tmp/orgamind-frontend-alignment-baseline.log, artefatos /tmp/gate-5iw94wrl. Não absorver regressões novas nessa dívida.

## Contrato de identidade e navegação

- Uma marca compartilhada: OrgaMind, símbolo O branco em quadrado laranja33px/raio8px, wordmark18px branco na navegação escura e navy em superfícies claras. Favicon corresponde ao SVG; HTML pt-BR e título/descrição consistentes.
- Workspace do painel: GBR Componentes (preferência explícita do usuário), abreviado GBR no breadcrumb. Esta identificação visual não altera identidade legal/consentimentos gravados; Configurações e opt-in continuam ligados à API existente.
- Sidebar210px expandida,64px colapsada; drawer móvel acessível preservado. Grupos Trabalho/Acompanhar/Administração. Rótulos Visão geral, Caixa de entrada, Nova campanha, Campanhas, Contatos, Templates, Segmentos, Números e canais, Usuários, Configurações conforme rotas reais.
- Adicionar atalho de criação de campanha existente ao menu. Nenhuma rota/banco/módulo de demandas/setores novo. Preservar destinos, guards, ADMIN/OPERATOR, itens ocultos de consentimento e chaves Picoa de storage/contratos legados.
- Topbar branca61px, breadcrumb12px, composição compacta com nome/avatar reais, busca/tema/novidades/status/seletor de provider preservados. Não causar overflow ao ter múltiplos providers ou texto longo.
- Papel apresentado em português, sem mudar enum. Sidebar marca/subtítulo workspace, rodapé workspace/Ambiente interno; rodapé global marca e versão dinâmica.

## Contrato visual

Paleta existente válida (#0a0f2b/#ef4b22/#f5f7fa/#ffffff/#17233b/#667286/#e0e5ed/#24537a), completar soft/navactive/navhover conforme referência. Fonte Roboto/Arial/sans-serif como protótipo; usar fallback disponível sem nova dependência/rede necessária. Eyebrow10px/.11em; H126px peso próximo da referência, h216px; botões12px/700/raio7px, foco visível legível e tema escuro equivalente.

Dashboard: H1 Visão geral e copy contextual real;4KPIs112px, gap11px, rótulo11px, valor30px, apoio10px, só primeiro topo laranja. Grid inferior1.65fr/1fr com gap14px: campanhas recentes (dados/entrega/leitura/status/datas reais) e Fluxo ao vivo compacto com5contadores reais. Substituir animação decorativa aleatória por painel legível. Nenhuma demanda, atualização, nome ou número ilustrativo inserido no produto. Loading/error/empty/retry intactos.

Login e troca de senha são extensão do design (não há login no protótipo): identidade visível desktop/móvel, cards claros de borda leve, texto operacional direto. Preservar credenciais, fluxo/guards/troca obrigatória/redirect seguro; nenhuma mudança de senha pelo agente.

Revisar grafia da marca em novidades e microcopy de produção. Não renomear campos/fromPicoa/picoaSent, storage, URLs/API ou migrações. Novidade PT-BR no topo do array conforme frontend/CLAUDE.md.

## BDDs e aceite

1. Desktop e390px: marca OrgaMind + empresa GBR Componentes visibles, favicon novo/título pt-BR, login identificável sem overflow.
2. ADMIN/OPERATOR: rotas anteriores disponíveis como antes, apenas nomes/grupos alterados; links novos apontam /campaigns/new; drawer abre/navega/fecha, colapso mantém tooltips.
3. Dashboard com dados/vazio/erro:4indicadores reais e fluxo5contadores preservados; campanhas/ações/status não se alteram. Tipografia/card/grid seguem medidas; mobile2KPIs e grid1coluna, dark legível.
4. Copy auxiliarnome consistente e release notes funcional. Auth schemas/session/guard/redirect intactos.
5. Tests pertinentes/typecheck/build/gate do diff PASS e review independente de integração. Gate global final comparado ao baseline por achados, não somente totais; dívida anterior reportada separadamente.
6. QA em browser com fixture local isolada para nome/layout/dados, sem uso de contas/secrets/provedores reais; release pode reutilizar autorização anterior de subir alterações/merge/main/deploy GBR depois de validação.
