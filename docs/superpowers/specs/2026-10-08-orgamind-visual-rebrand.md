# Orgamind — rebrand visual a partir do protótipo

## Referência e escopo

Referência visual fornecida pelo usuário: `/home/andre-lima/Downloads/OrgaMind-Prototipo.html` (protótipo local, 8/10/2026). O HTML mostra uma operação interna da GBR Componentes, com fluxos de demandas entre setores. Neste projeto ele define apenas a linguagem visual; a navegação, os dados, os textos e os fluxos de campanhas, contatos, consentimento e WhatsApp continuam sendo os do Orgamind.

## Contrato visual

- Paleta clara: navegação `#0a0f2b`, acento `#ef4b22`, canvas `#f5f7fa`, superfície `#ffffff`, texto `#17233b`, texto secundário `#667286`, divisória `#e0e5ed`, link informativo `#24537a`. Tons verde e âmbar são semânticos.
- Tipografia: Roboto com fallback Arial/sans-serif, escala compacta e legível. Títulos em azul-marinho, números tabulares nos indicadores. Não importar o conteúdo, organização ou números de demonstração do protótipo.
- Estrutura: barra lateral escura, item ativo com fundo azul e traço laranja à esquerda; barra superior branca; conteúdo sobre cinza claro; cartões brancos com borda leve e raio contido; botões primários azul-marinho; foco visível laranja.
- Padrões: indicadores em cartões compactos com um único acento laranja; listas e tabelas com separadores claros; inbox em painéis definidos; formulários com campos brancos, bordas claras e etapas legíveis.
- Rebrand consistente nos tokens, componentes base, shell e telas principais, incluindo estados vazios e de carregamento. Responsividade e navegação por teclado permanecem funcionais. O tema escuro existente recebe equivalentes legíveis, pois o protótipo só especifica o claro.

## Aceite

1. Tokens e componentes compartilhados aplicam a paleta a toda a aplicação, sem roxo/ciano como marca remanescente.
2. Shell, dashboard, inbox e criação de campanha refletem o protótipo em hierarquia, espaçamento, superfícies e estados interativos, preservando ações e conteúdo reais.
3. Layouts desktop e móvel não têm sobreposição ou rolagem horizontal indevida; foco e contraste são perceptíveis.
4. Testes funcionais existentes, typecheck, build e gate aplicável passam; inspeção visual compara as telas implementadas ao protótipo.

## Fora do escopo

Novos recursos de demandas/setores da GBR, alterações de API ou banco, credenciais, deploy, commit e publicação.
