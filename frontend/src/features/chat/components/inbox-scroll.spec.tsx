import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * O inbox não rolava: com 138 conversas o operador via ~10 e não alcançava as
 * outras 128.
 *
 * A causa NÃO era o `overflow-y-auto` (ele estava lá). Era a altura não chegar
 * até ele:
 *  - o contêiner do inbox é um grid com altura definida, mas `grid-auto-rows` é
 *    `auto` — a linha implícita se dimensiona pelo CONTEÚDO (~2044px), ignorando
 *    a altura do contêiner (815px). As colunas esticam para a LINHA, e o `h-full`
 *    delas passa a valer 100% de 2044px;
 *  - dentro das colunas, o painel rolável é um filho flex, e `min-height: auto`
 *    o proíbe de encolher abaixo do conteúdo — ele cresce em vez de rolar.
 * Sem os dois, o `overflow-y-auto` nunca tem o que rolar e o `overflow-hidden`
 * do grid só decepa o excedente.
 *
 * Medido no browser (prod), antes → depois do fix:
 *   grid-template-rows: 2043.5px → 815px
 *   altura da lista:     1800px  → 572px  (scrollHeight segue 1800)
 *   rola?                não     → sim
 *
 * Por que asserção de CLASSE e não de layout: jsdom não tem motor de layout —
 * `clientHeight`/`scrollHeight` são sempre 0 e um teste de rolagem passaria
 * verde com o bug de pé. O que dá para proteger de verdade é a presença das
 * classes: elas são a correção, e removê-las traz o bug de volta.
 */
const src = (p: string) =>
  readFileSync(resolve(__dirname, p), 'utf8');

describe('inbox — as classes que fazem o scroll existir', () => {
  it('o grid trava a linha na altura do contêiner (senão ela cresce até o conteúdo)', () => {
    const route = src('../../../routes/_authenticated/inbox/route.tsx');
    const grid = route.match(/className="grid[^"]*"/)?.[0] ?? '';

    expect(grid).toContain('h-[calc(100vh-8rem)]');
    expect(grid).toContain('grid-rows-[minmax(0,1fr)]');
  });

  it('no celular mostra apenas o painel útil e libera duas colunas no desktop', () => {
    const route = src('../../../routes/_authenticated/inbox/route.tsx');

    expect(route).toContain('grid-cols-1');
    expect(route).toContain('lg:grid-cols-[330px_minmax(0,1fr)]');
    expect(route).toContain("params.conversationId ? 'hidden h-full lg:block' : 'h-full'");
    expect(route).toContain("params.conversationId ? 'h-full min-h-0' : 'hidden min-h-0 lg:block'");
  });

  it('a lista de conversas pode encolher abaixo do conteúdo e rolar', () => {
    const list = src('./conversations-list.tsx');
    expect(list).toMatch(/className="min-h-0 flex-1 overflow-y-auto"/);
  });

  it('o histórico de mensagens também — senão o composer sai da tela', () => {
    const thread = src('./message-thread.tsx');
    expect(thread).toMatch(/className="min-h-0 flex-1[^"]*overflow-y-auto[^"]*"/);
  });
});
