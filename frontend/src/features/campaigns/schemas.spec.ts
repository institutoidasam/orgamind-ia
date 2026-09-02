import { describe, it, expect } from 'vitest';
import {
  filterGroupSchema,
  historyRuleSchema,
  FAILURE_REASONS,
  RECIPIENT_GROUPS,
} from './schemas';

/**
 * historyRuleSchema must mirror backend/src/schemas/contracts/filter.schema.ts
 * BYTE-FOR-BYTE on validation behaviour (message text and issue paths
 * included): if the wizard accepts something the backend rejects, the
 * dispatch call comes back 400 after the operator already built the filter.
 */
describe('historyRuleSchema', () => {
  it('accepts a received node with non-empty campaignIds', () => {
    const parsed = historyRuleSchema.safeParse({
      kind: 'history',
      event: 'received',
      negate: false,
      campaignIds: ['camp-1'],
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts a node with only templateIds (no campaignIds)', () => {
    const parsed = historyRuleSchema.safeParse({
      kind: 'history',
      event: 'received',
      negate: true,
      templateIds: ['tpl-1'],
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an empty target — both campaignIds and templateIds absent', () => {
    const parsed = historyRuleSchema.safeParse({
      kind: 'history',
      event: 'received',
      negate: false,
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects an empty target — both campaignIds and templateIds are []', () => {
    const parsed = historyRuleSchema.safeParse({
      kind: 'history',
      event: 'received',
      negate: false,
      campaignIds: [],
      templateIds: [],
    });
    expect(parsed.success).toBe(false);
  });

  // Espelha o teste do backend (F1 T2): o issue de alvo-vazio não pode ficar
  // preso só em `campaignIds` — senão a UI não sabe marcar `templateIds`
  // quando foi esse o campo que o operador tentou (e falhou) preencher.
  it('flags an empty target on BOTH campaignIds and templateIds paths, not just campaignIds', () => {
    const parsed = historyRuleSchema.safeParse({
      kind: 'history',
      event: 'received',
      negate: false,
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error('unreachable');
    const paths = parsed.error.issues.map((i) => i.path.join('.'));
    expect(paths).toContain('campaignIds');
    expect(paths).toContain('templateIds');
  });

  it('rejects failureReason when event is not "failed"', () => {
    const parsed = historyRuleSchema.safeParse({
      kind: 'history',
      event: 'received',
      negate: false,
      campaignIds: ['camp-1'],
      failureReason: 'SEM_WHATSAPP',
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts failureReason when event is "failed"', () => {
    const parsed = historyRuleSchema.safeParse({
      kind: 'history',
      event: 'failed',
      negate: false,
      campaignIds: ['camp-1'],
      failureReason: 'SEM_WHATSAPP',
    });
    expect(parsed.success).toBe(true);
  });

  // F2 T5: failureReason apertou de z.string().min(1) para um z.enum fechado
  // com os 11 valores de FailureReason (espelhando o back, que usa
  // z.nativeEnum(FailureReason) importado de @prisma/client) — um valor fora
  // da lista (mesmo não-vazio) tem que ser rejeitado.
  it('rejects a failureReason outside the FailureReason enum', () => {
    const parsed = historyRuleSchema.safeParse({
      kind: 'history',
      event: 'failed',
      negate: false,
      campaignIds: ['camp-1'],
      failureReason: 'not-a-real-reason',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects an empty-string failureReason', () => {
    const parsed = historyRuleSchema.safeParse({
      kind: 'history',
      event: 'failed',
      negate: false,
      campaignIds: ['camp-1'],
      failureReason: '',
    });
    expect(parsed.success).toBe(false);
  });

  // Paridade com o back: os 11 valores do enum Prisma FailureReason precisam
  // ser TODOS aceitos (nenhum a mais, nenhum a menos).
  it.each(FAILURE_REASONS)('accepts the FailureReason enum member %s', (reason) => {
    const parsed = historyRuleSchema.safeParse({
      kind: 'history',
      event: 'failed',
      negate: false,
      campaignIds: ['camp-1'],
      failureReason: reason,
    });
    expect(parsed.success).toBe(true);
  });

  it('validates a history node nested inside a filterGroupSchema group', () => {
    const parsed = filterGroupSchema.safeParse({
      combinator: 'and',
      rules: [
        { field: 'city', op: 'eq', value: 'Manaus' },
        {
          kind: 'history',
          event: 'received',
          negate: false,
          campaignIds: ['camp-1'],
        },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a nested group containing an invalid (empty-target) history node', () => {
    const parsed = filterGroupSchema.safeParse({
      combinator: 'and',
      rules: [
        {
          combinator: 'or',
          rules: [{ kind: 'history', event: 'received', negate: false }],
        },
      ],
    });
    expect(parsed.success).toBe(false);
  });
});

/**
 * F2 T7 — os grupos da tela de destinatários espelham
 * `listCampaignRecipientsQuerySchema.group` de
 * backend/src/schemas/contracts/campaign.schema.ts. "failed" existia no
 * backend (rota + repositório) e NÃO aqui: o tipo do front não conhecia o
 * grupo, então a aba de falhas era inalcançável pela UI — código morto dos
 * dois lados da fronteira.
 */
describe('RECIPIENT_GROUPS', () => {
  it('espelha o enum de grupos do backend, incluindo "failed"', () => {
    expect([...RECIPIENT_GROUPS]).toEqual([
      'sent',
      'pending',
      'unreachable',
      'skipped',
      'failed',
    ]);
  });
});

import { createCampaignSchema } from './schemas';

/**
 * A.1/A.3 — o wizard deixou de mandar "Limitar aos primeiros". O contrato do
 * front tem de espelhar o do back, que agora RECUSA o campo: se o schema daqui
 * continuasse carregando `limit`, o operador levaria 400 depois de montar a
 * campanha inteira.
 */
describe('A.1 — createCampaignSchema (front) não carrega mais "limit"', () => {
  const base = {
    name: 'Campanha',
    templateId: 'tpl1',
    defaultInstanceId: 'clabcdefghijklmnopqrstuvw',
    filters: { combinator: 'and', rules: [] },
    variableMap: {},
  };

  it('descarta o campo mesmo quando ele é passado', () => {
    const parsed = createCampaignSchema.parse({ ...base, limit: 500 } as never);
    expect('limit' in parsed).toBe(false);
  });
});
