import { describe, it, expect, beforeEach } from 'vitest';
import { mockDeep, type MockProxy } from 'vitest-mock-extended';
import { ConsentController } from './consent.controller';
import { ConsentService } from './consent.service';
import {
  ConsentMetricsService,
  type ConsentOverview,
} from './consent-metrics.service';
import {
  SourceOriginService,
  type ClassifyReport,
} from './source-origin.service';

/**
 * C1b/C5 — os endpoints de leitura do consentimento.
 *
 * Autenticados pelo JwtAuthGuard global (app.module.ts): NÃO levam @Public(). O
 * conjunto de finalidades do IDASAM é configuração interna, não conteúdo
 * público — a landing de opt-in (§3) renderiza o texto canônico, não esta lista.
 */
describe('ConsentController', () => {
  let controller: ConsentController;
  let consent: MockProxy<ConsentService>;
  let metrics: MockProxy<ConsentMetricsService>;
  let sourceOrigin: MockProxy<SourceOriginService>;

  beforeEach(() => {
    consent = mockDeep<ConsentService>();
    metrics = mockDeep<ConsentMetricsService>();
    sourceOrigin = mockDeep<SourceOriginService>();
    controller = new ConsentController(consent, metrics, sourceOrigin);
  });

  it('GET /consent/purposes devolve as finalidades ativas', async () => {
    const purposes = [
      {
        key: 'comunicacao_institucional',
        label: 'Notícias e avisos do IDASAM',
        description: 'comunicados gerais do instituto',
        isSensitive: false,
      },
    ];
    consent.listPurposes.mockResolvedValue(purposes);

    await expect(controller.listPurposes()).resolves.toEqual(purposes);
    expect(consent.listPurposes).toHaveBeenCalledOnce();
  });

  it('GET /consent/overview devolve o painel de opt-in (spec §7)', async () => {
    const overview = { total: 13_000, podemReceberHoje: 87 } as ConsentOverview;
    metrics.overview.mockResolvedValue(overview);

    await expect(controller.overview()).resolves.toBe(overview);
    expect(metrics.overview).toHaveBeenCalledOnce();
  });

  it('POST /consent/audit/classify reexecuta a auditoria das coortes', async () => {
    const report = {
      scanned: 13_000,
      updated: 12,
      unchanged: 12_988,
    } as ClassifyReport;
    sourceOrigin.classifyAll.mockResolvedValue(report);

    await expect(controller.classify()).resolves.toBe(report);
    expect(sourceOrigin.classifyAll).toHaveBeenCalledOnce();
  });
});
