# CLAUDE.md — frontend

Notas específicas do frontend do ORGAMIND (React + TanStack Router/Query). Para
o fluxo de desenvolvimento (delegação, revisão, paralelização) e outras
regras de projeto, ver as instruções globais do usuário — este arquivo só
registra convenções deste diretório.

## Novidades

Todo PR com mudança visível ao operador (nova tela, novo filtro, botão,
comportamento que muda o que ele vê ou pode fazer) adiciona uma entrada em
`frontend/src/release-notes.ts`. É a fonte do badge "Novo" no topbar, do
diálogo "Novidades" e do rodapé de versão — ver a Fase C de
`docs/superpowers/specs/2026-08-24-campanha-em-lotes-invalidos-novidades-design.md`.

- Texto em PT-BR, escrito para o operador (o que mudou na experiência dele),
  não para quem programa.
- `where` (rota interna, ex. `/contacts`) só quando existe uma tela
  específica para linkar via "Ver".
- Entrada nova sempre no TOPO do array `RELEASE_NOTES` — a ordem é
  decrescente por `version` ('YYYY.MM.DD' ou 'YYYY.MM.DD.n').
- `frontend/src/release-notes.spec.ts` tem um teste-lembrete: se a versão
  mais nova ficar mais de 60 dias sem atualização, a suíte passa a falhar
  sozinha — é o sinal de que esta seção foi esquecida em algum PR.
