import { describe, it, expect, vi } from 'vitest';
import {
  DELIVERED_STATUSES,
  INDEX_EXCLUDED_STATUSES,
  buildMeasurement,
  formatReport,
  measureDuplicateCampaignDeliveries,
  parseDays,
  parseTop,
  type CampaignDuplicateRow,
  type DuplicateDeliveryReport,
} from './measure-duplicate-campaign-deliveries';

/**
 * A medição do §0.6 CORRIGIDO: DUAS consultas, porque respondem perguntas
 * diferentes e não dão o mesmo número —
 *
 *   (a) danoReal: quem RECEBEU (D2: SENT|DELIVERED|READ, OUTBOUND) a mesma
 *       campanha mais de uma vez;
 *   (b) violaIndice: pares que o índice PARCIAL do §0.7 rejeitaria — recorte
 *       mais largo (status NOT IN os 5 terminais/pulados, SEM filtro de
 *       direção, porque é o mesmo predicado do índice);
 *
 * mais o DENOMINADOR (pares realmente entregues) e o recorte `--days`.
 *
 * O script é SOMENTE LEITURA — não existe `--apply`, e nenhum teste aqui pode
 * ver uma escrita.
 */
describe('measure-duplicate-campaign-deliveries', () => {
  /** `$queryRaw` mockado para responder, em ordem de chamada, a cada consulta. */
  const dbSeq = (...responses: unknown[][]) => {
    const $queryRaw = vi.fn();
    for (const r of responses) $queryRaw.mockResolvedValueOnce(r);
    return { $queryRaw } as never;
  };

  /**
   * Reconstrói o SQL e os parâmetros de UMA chamada a `$queryRaw`.
   *
   * O mock não é o Prisma real — ele não sabe achatar um fragmento
   * `Prisma.sql`/`Prisma.join` aninhado, então esse fragmento chega aqui como
   * um VALOR (um objeto `Sql`, com as suas próprias `.strings`/`.values` já
   * achatadas pelo `Prisma.sql` de verdade na hora em que o script o
   * construiu). Este helper junta o texto de volta — sem ele, `NOT IN` e
   * `"createdAt" >=` (que moram DENTRO do fragmento aninhado) nunca apareceriam
   * no SQL reconstruído, e o teste enxergaria só o `?` do placeholder.
   */
  const flattenCall = (call: unknown[]): { sql: string; values: unknown[] } => {
    const [strings, ...params] = call as [readonly string[], ...unknown[]];
    const textOf = (p: unknown): string => {
      const s = (p as { strings?: readonly string[] })?.strings;
      return s ? s.join('?') : '?';
    };
    const sql = strings.reduce(
      (acc, part, i) => acc + part + (i < params.length ? textOf(params[i]) : ''),
      '',
    );
    const values = params.flatMap((p) => (p as { values?: unknown[] })?.values ?? [p]);
    return { sql, values };
  };

  describe('measureDuplicateCampaignDeliveries', () => {
    it('mede as duas contagens e o percentual de cada uma sobre o denominador', async () => {
      const report = await measureDuplicateCampaignDeliveries(
        dbSeq(
          // (a) danoReal
          [{ campaignId: 'c1', campaignName: 'Convite', pairs: 3, excess: 4 }],
          // (b) violaIndice
          [{ campaignId: 'c1', campaignName: 'Convite', pairs: 5, excess: 6 }],
          // denominador
          [{ n: 100 }],
        ),
      );

      expect(report.totalDelivered).toBe(100);
      expect(report.danoReal.duplicatePairs).toBe(3);
      expect(report.danoReal.excessMessages).toBe(4);
      expect(report.danoReal.percentOfDelivered).toBe(3);
      expect(report.violaIndice.duplicatePairs).toBe(5);
      expect(report.violaIndice.excessMessages).toBe(6);
      expect(report.violaIndice.percentOfDelivered).toBe(5);
    });

    it('converte o BIGINT do COUNT do Postgres nas três consultas — somar bigint com number explode', async () => {
      const report = await measureDuplicateCampaignDeliveries(
        dbSeq(
          [{ campaignId: 'c1', campaignName: 'Convite', pairs: BigInt(2), excess: BigInt(5) }],
          [{ campaignId: 'c1', campaignName: 'Convite', pairs: BigInt(3), excess: BigInt(7) }],
          [{ n: BigInt(50) }],
        ),
      );

      expect(report.totalDelivered).toBe(50);
      expect(report.danoReal.duplicatePairs).toBe(2);
      expect(report.danoReal.topCampaigns[0].excess).toBe(5);
      expect(report.violaIndice.duplicatePairs).toBe(3);
      expect(report.violaIndice.topCampaigns[0].excess).toBe(7);
    });

    it('base limpa: zero em tudo, sem quebrar', async () => {
      const report = await measureDuplicateCampaignDeliveries(dbSeq([], [], []));

      expect(report.totalDelivered).toBe(0);
      expect(report.danoReal).toEqual({
        duplicatePairs: 0,
        excessMessages: 0,
        campaignsAffected: 0,
        percentOfDelivered: 0,
        topCampaigns: [],
      });
      expect(report.violaIndice).toEqual({
        duplicatePairs: 0,
        excessMessages: 0,
        campaignsAffected: 0,
        percentOfDelivered: 0,
        topCampaigns: [],
      });
    });

    it('NÃO ESCREVE NADA: roda exatamente 3 SELECTs — danoReal, violaIndice, denominador', async () => {
      const $queryRaw = vi.fn().mockResolvedValue([]);
      const client = { $queryRaw } as never;

      await measureDuplicateCampaignDeliveries(client);

      expect($queryRaw).toHaveBeenCalledTimes(3);

      const [danoReal, violaIndice, denominador] = $queryRaw.mock.calls.map(flattenCall);

      for (const { sql } of [danoReal, violaIndice, denominador]) {
        expect(sql).not.toMatch(/INSERT|UPDATE|DELETE/i);
      }

      // (a) danoReal: OUTBOUND + os três status de "recebeu" (D2), como parâmetro.
      expect(danoReal.sql).toContain('HAVING COUNT(*) > 1');
      expect(danoReal.values).toEqual(['OUTBOUND', ...DELIVERED_STATUSES]);

      // (b) violaIndice: SEM 'OUTBOUND' — é o mesmo predicado do índice do §0.7,
      // que não filtra direção. Só os 5 status excluídos, via NOT IN.
      expect(violaIndice.sql).toContain('HAVING COUNT(*) > 1');
      expect(violaIndice.sql).toContain('NOT IN');
      expect(violaIndice.values).toEqual([...INDEX_EXCLUDED_STATUSES]);

      // denominador: mesmo recorte de "recebeu" do (a), sem HAVING (é contagem simples).
      expect(denominador.sql).not.toContain('HAVING');
      expect(denominador.values).toEqual(['OUTBOUND', ...DELIVERED_STATUSES]);
    });

    it('sem --days, nenhuma das três consultas filtra createdAt', async () => {
      const $queryRaw = vi.fn().mockResolvedValue([]);
      await measureDuplicateCampaignDeliveries({ $queryRaw } as never);

      for (const call of $queryRaw.mock.calls) {
        const [strings] = call as [TemplateStringsArray];
        expect(strings.join('?')).not.toContain('createdAt');
      }
    });

    it('--days aplica o recorte temporal às três consultas', async () => {
      const $queryRaw = vi.fn().mockResolvedValue([]);
      await measureDuplicateCampaignDeliveries({ $queryRaw } as never, { days: 7 });

      expect($queryRaw).toHaveBeenCalledTimes(3);
      for (const call of $queryRaw.mock.calls) {
        const { sql, values } = flattenCall(call as unknown[]);
        expect(sql).toContain('"createdAt" >=');
        expect(values.some((v) => v instanceof Date)).toBe(true);
      }
    });
  });

  describe('buildMeasurement', () => {
    const rows: CampaignDuplicateRow[] = Array.from({ length: 25 }, (_, i) => ({
      campaignId: `c${i}`,
      campaignName: `Campanha ${i}`,
      pairs: 1,
      excess: i,
    }));

    it('corta o top em 20 por padrão, mas os TOTAIS são da base inteira', () => {
      const m = buildMeasurement(rows);

      expect(m.topCampaigns).toHaveLength(20);
      expect(m.campaignsAffected).toBe(25);
      expect(m.duplicatePairs).toBe(25);
      expect(m.excessMessages).toBe(300); // 0+1+…+24
      expect(m.topCampaigns[0].campaignId).toBe('c24');
    });

    it('desempata excedente igual pelo número de pares', () => {
      const m = buildMeasurement([
        { campaignId: 'a', campaignName: 'A', pairs: 2, excess: 5 },
        { campaignId: 'b', campaignName: 'B', pairs: 5, excess: 5 },
      ]);

      expect(m.topCampaigns.map((c) => c.campaignId)).toEqual(['b', 'a']);
    });

    it('calcula o percentual sobre o denominador, arredondado a 1 casa', () => {
      const m = buildMeasurement(
        [{ campaignId: 'a', campaignName: 'A', pairs: 15, excess: 1 }],
        20,
        200,
      );

      expect(m.duplicatePairs).toBe(15);
      expect(m.percentOfDelivered).toBe(7.5); // 15/200 * 100
    });

    it('percentual zero quando o denominador é zero, mesmo com pares duplicados', () => {
      const m = buildMeasurement(
        [{ campaignId: 'a', campaignName: 'A', pairs: 10, excess: 1 }],
        20,
        0,
      );

      expect(m.percentOfDelivered).toBe(0);
    });
  });

  describe('parseTop', () => {
    it('lê --top e ignora lixo', () => {
      expect(parseTop(['node', 'script.ts', '--top', '50'])).toBe(50);
      expect(parseTop(['node', 'script.ts'])).toBe(20);
      expect(parseTop(['node', 'script.ts', '--top', 'abc'])).toBe(20);
      expect(parseTop(['node', 'script.ts', '--top', '0'])).toBe(20);
      expect(parseTop(['node', 'script.ts', '--top'])).toBe(20);
    });
  });

  describe('parseDays', () => {
    it('lê --days e ignora lixo; sem o flag, sem recorte (undefined)', () => {
      expect(parseDays(['node', 'script.ts', '--days', '7'])).toBe(7);
      expect(parseDays(['node', 'script.ts'])).toBeUndefined();
      expect(parseDays(['node', 'script.ts', '--days', 'abc'])).toBeUndefined();
      expect(parseDays(['node', 'script.ts', '--days', '0'])).toBeUndefined();
      expect(parseDays(['node', 'script.ts', '--days'])).toBeUndefined();
    });
  });

  describe('formatReport', () => {
    const report: DuplicateDeliveryReport = {
      totalDelivered: 100,
      danoReal: buildMeasurement(
        [{ campaignId: 'c1', campaignName: 'Convite', pairs: 3, excess: 4 }],
        20,
        100,
      ),
      violaIndice: buildMeasurement(
        [{ campaignId: 'c1', campaignName: 'Convite', pairs: 5, excess: 6 }],
        20,
        100,
      ),
    };

    it('imprime o denominador e as duas medições, cada uma com seu percentual', () => {
      const out = formatReport(report);

      expect(out).toContain('ENTREGUES (denominador) ...... 100');
      // danoReal: 3 pares (3% de 100), 4 excedentes.
      expect(out).toContain('duplicados ... 3 (3% do entregue)');
      expect(out).toContain('excedentes ................... 4');
      // violaIndice: 5 pares (5% de 100), 6 excedentes.
      expect(out).toContain('duplicados ... 5 (5% do entregue)');
      expect(out).toContain('excedentes ................... 6');
      // as duas medições dão o mesmo par (c1, "Convite") no exemplo, e o
      // relatório precisa listá-lo nas DUAS seções — não só numa.
      expect(out.split('"Convite"')).toHaveLength(3); // 2 ocorrências + 1 sobra do split
    });

    it('diz explicitamente que a medição está limpa em vez de imprimir um top vazio', () => {
      const clean: DuplicateDeliveryReport = {
        totalDelivered: 0,
        danoReal: buildMeasurement([], 20, 0),
        violaIndice: buildMeasurement([], 20, 0),
      };

      const out = formatReport(clean);
      expect(out).toContain('Nenhum reenvio duplicado');
    });

    it('sem --days, o relatório declara que é a base inteira', () => {
      expect(formatReport(report)).toMatch(/base inteira|sem --days/);
    });

    it('com --days, o relatório declara o recorte usado', () => {
      expect(formatReport(report, { days: 30 })).toContain('30');
    });
  });
});
