import { describe, it, expect } from 'vitest';
import { RELEASE_NOTES, latestRelease, daysSinceLatestRelease } from './release-notes';

/**
 * Compara 'YYYY.MM.DD[.n]' segmento a segmento como número — uma comparação
 * lexicográfica de string quebraria no sufixo opcional (`.2` viria "menor"
 * que `.10`, por exemplo).
 */
function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

describe('RELEASE_NOTES', () => {
  it('não é vazio', () => {
    // latestRelease() devolve RELEASE_NOTES[0] sem checar limites — um
    // catálogo vazio devolveria `undefined` e quebraria o rodapé e o botão
    // "Novidades" (tela branca no shell inteiro).
    expect(RELEASE_NOTES.length).toBeGreaterThan(0);
  });

  it('está em ordem decrescente por version (mais nova primeiro)', () => {
    for (let i = 0; i < RELEASE_NOTES.length - 1; i++) {
      expect(
        compareVersions(RELEASE_NOTES[i].version, RELEASE_NOTES[i + 1].version),
      ).toBeGreaterThan(0);
    }
  });

  it('não repete version', () => {
    const versions = RELEASE_NOTES.map((n) => n.version);
    expect(new Set(versions).size).toBe(versions.length);
  });

  it('version está no formato YYYY.MM.DD ou YYYY.MM.DD.n', () => {
    for (const n of RELEASE_NOTES) {
      expect(n.version).toMatch(/^\d{4}\.\d{2}\.\d{2}(\.\d+)?$/);
    }
  });

  it('date está no formato YYYY-MM-DD e nunca é futura', () => {
    const now = new Date();
    for (const n of RELEASE_NOTES) {
      expect(n.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(new Date(`${n.date}T00:00:00`).getTime()).toBeLessThanOrEqual(now.getTime());
    }
  });

  it('title e o texto de cada item não são vazios', () => {
    for (const n of RELEASE_NOTES) {
      expect(n.title.trim().length).toBeGreaterThan(0);
      expect(n.items.length).toBeGreaterThan(0);
      for (const item of n.items) {
        expect(item.text.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it('where, quando presente, começa com "/"', () => {
    for (const n of RELEASE_NOTES) {
      for (const item of n.items) {
        if (item.where !== undefined) {
          expect(item.where.startsWith('/')).toBe(true);
        }
      }
    }
  });
});

describe('latestRelease', () => {
  it('retorna a primeira entrada do array', () => {
    expect(latestRelease()).toEqual(RELEASE_NOTES[0]);
  });

  // Âncora à prova de inserção: NÃO trava a versão mais nova numa string
  // fixa — as Fases A e B inserem cada uma sua própria entrada no TOPO de
  // RELEASE_NOTES, e travar aqui forçaria as duas a editar esta mesma linha
  // (conflito de merge garantido). "retorna a primeira entrada do array"
  // (acima) + a ordem decrescente (describe seguinte) já cobrem que a mais
  // nova É a primeira; aqui só provamos que o backfill de 23/08 está no
  // catálogo.
  // NOTA: os planos de A/B têm um passo "atualizar a asserção de
  // latestRelease" — com esta mudança esse passo vira no-op.
  it('o catálogo inclui o backfill de 2026.08.23 ("Ninguém recebe a mesma mensagem duas vezes")', () => {
    expect(RELEASE_NOTES.some((n) => n.version === '2026.08.23')).toBe(true);
  });
});

describe('daysSinceLatestRelease', () => {
  it('calcula os dias corridos desde a versão mais nova', () => {
    const latest = latestRelease();
    const latestDate = new Date(`${latest.date}T00:00:00`);
    const twoDaysLater = new Date(latestDate.getTime() + 2 * 24 * 60 * 60 * 1000);
    expect(daysSinceLatestRelease(twoDaysLater)).toBe(2);
  });

  it('serve de lembrete: a versão mais nova não pode ficar mais de 60 dias sem atualização', () => {
    expect(
      daysSinceLatestRelease(),
      'A entrada mais nova de RELEASE_NOTES tem mais de 60 dias — adicione a entrada do seu PR (ver frontend/CLAUDE.md)',
    ).toBeLessThanOrEqual(60);
  });

  it('conta certo mesmo quando o dia local "perde" 1 hora (horário de verão)', () => {
    // A implementação antiga usava `now` cru (sem normalizar para a meia-noite
    // do seu próprio dia local) e arredondava para baixo (Math.floor). Em
    // fusos que observam horário de verão, o dia da virada tem só 23h — o
    // relógio de Sydney avança de GMT+10 para GMT+11 em 2026-10-04 (verificado
    // em runtime: `new Date(2026,9,5) - new Date(2026,9,3)`, os dois em
    // horário LOCAL de Sydney, dá 47h corridas, não 48h — `Date.UTC` não
    // observa fuso/horário de verão e sempre daria 48h certinho, por isso o
    // valor esperado abaixo usa `Date.UTC` como referência independente).
    // Isso fazia a contagem antiga subtrair 1 dia do resultado. `now` é a
    // meia-noite local de 2026-10-05 nesse fuso — um dia depois da virada.
    // O valor esperado é calculado de forma independente, via `Date.UTC`
    // puro (sem fuso, sem horário de verão), para não repetir a lógica sob
    // teste.
    //
    // A mutação de `process.env.TZ` só tem efeito porque o vitest deste
    // projeto roda no pool `forks` (processo próprio por arquivo de teste —
    // não há `pool` explícito em vitest.config.ts, mas isolar por processo é
    // o que permite reatribuir TZ em runtime); no pool `threads` a mutação é
    // no-op (threads de um mesmo processo Node compartilham e já resolveram
    // o fuso do processo na inicialização).
    const originalTz = process.env.TZ;
    process.env.TZ = 'Australia/Sydney';
    try {
      const [year, month, day] = latestRelease().date.split('-').map(Number);
      const now = new Date(2026, 9, 5);
      const expectedDays = Math.round(
        (Date.UTC(2026, 9, 5) - Date.UTC(year, month - 1, day)) / (24 * 60 * 60 * 1000),
      );
      expect(daysSinceLatestRelease(now)).toBe(expectedDays);
    } finally {
      // `originalTz` pode ser `undefined` (TZ nunca setada no processo) — atribuir
      // `process.env.TZ = undefined` grava a STRING "undefined" (env vars só
      // guardam string), o que travaria o processo em UTC pelo resto da suíte.
      if (originalTz === undefined) delete process.env.TZ;
      else process.env.TZ = originalTz;
    }
  });
});

describe('entregas registradas (uma entrada por fase visível)', () => {
  it('a entrega dos lotes (Fase A) está registrada', () => {
    const entrada = RELEASE_NOTES.find((r) => r.title.includes('Envio em lotes'));
    expect(entrada).toBeDefined();
    expect(entrada?.items.some((i) => i.text.includes('quantos faltam'))).toBe(true);
  });

  it('cada versão é bem formada (YYYY.MM.DD[.n])', () => {
    for (const r of RELEASE_NOTES) {
      expect(r.version).toMatch(/^\d{4}\.\d{2}\.\d{2}(\.\d+)?$/);
    }
  });

  it('a entrega dos números inválidos está registrada', () => {
    const entrada = RELEASE_NOTES.find((r) =>
      r.title.includes('Números inválidos'),
    );
    expect(entrada).toBeDefined();
    expect(entrada?.items.some((i) => i.text.includes('Validação'))).toBe(true);
  });
});
