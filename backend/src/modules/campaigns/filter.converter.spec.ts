import { describe, it, expect } from 'vitest';
import { toPrismaWhere } from './filter.converter';
import { REACHED_STATUSES } from './batch-audience';
import { ValidationError } from '../../shared/errors/domain.error';

describe('toPrismaWhere', () => {
  it('handles single eq rule', () => {
    const where = toPrismaWhere({
      combinator: 'and',
      rules: [{ field: 'city', op: 'eq', value: 'Manaus' }],
    });
    expect(where).toEqual({ AND: [{ city: 'Manaus' }] });
  });

  it('handles nested OR', () => {
    const where = toPrismaWhere({
      combinator: 'and',
      rules: [
        { field: 'city', op: 'eq', value: 'Manaus' },
        {
          combinator: 'or',
          rules: [
            { field: 'group', op: 'eq', value: 'alunos' },
            { field: 'tags', op: 'contains', value: 'vip' },
          ],
        },
      ],
    });
    expect(where).toEqual({
      AND: [
        { city: 'Manaus' },
        { OR: [{ group: 'alunos' }, { tags: { has: 'vip' } }] },
      ],
    });
  });

  // ★ Decisão do cliente 2026-08-25 — opt-out DEIXOU de ser um filtro
  // automático do PÚBLICO da campanha (ver o docstring de `toPrismaWhere`).
  // Um contato com opt-out agora casa normalmente com o filtro; a proteção
  // continua existindo, só que no CAMINHO DE ENVIO (defesa em profundidade em
  // `CampaignsService#dispatchAudience`, `send-message.processor.ts` e
  // `zernio-broadcast-send.service.ts` — nenhum tocado por este arquivo).
  it('não filtra mais por opt-out — filtro vazio devolve {} (RED antes desta mudança: devolvia { optedOut: false })', () => {
    const where = toPrismaWhere({ combinator: 'and', rules: [] });
    expect(where).toEqual({});
    expect(JSON.stringify(where)).not.toContain('optedOut');
  });

  it('não filtra mais por opt-out em nenhum filtro não-vazio (RED antes desta mudança: sempre incluía { optedOut: false })', () => {
    const where = toPrismaWhere({
      combinator: 'and',
      rules: [{ field: 'city', op: 'eq', value: 'Manaus' }],
    });
    expect(JSON.stringify(where)).not.toContain('optedOut');
  });

  it('contains on string fields uses insensitive contains', () => {
    const where = toPrismaWhere({
      combinator: 'and',
      rules: [{ field: 'name', op: 'contains', value: 'João' }],
    });
    expect(where).toEqual({
      AND: [{ name: { contains: 'João', mode: 'insensitive' } }],
    });
  });

  it('isNull and notNull', () => {
    const where = toPrismaWhere({
      combinator: 'and',
      rules: [
        { field: 'city', op: 'isNull' },
        { field: 'group', op: 'notNull' },
      ],
    });
    expect(where).toEqual({
      AND: [{ city: null }, { group: { not: null } }],
    });
  });

  describe('history rule — event:received', () => {
    it('negate:false becomes messages:{some:...}, reachable via REACHED_STATUSES', () => {
      const where = toPrismaWhere({
        combinator: 'and',
        rules: [
          {
            kind: 'history',
            event: 'received',
            negate: false,
            campaignIds: ['camp-1', 'camp-2'],
          },
        ],
      });
      expect(where).toEqual({
        AND: [
          {
            messages: {
              some: {
                campaignId: { in: ['camp-1', 'camp-2'] },
                direction: 'OUTBOUND',
                status: { in: REACHED_STATUSES },
              },
            },
          },
        ],
      });
    });

    it('negate:true becomes messages:{none:...}', () => {
      const where = toPrismaWhere({
        combinator: 'and',
        rules: [
          {
            kind: 'history',
            event: 'received',
            negate: true,
            campaignIds: ['camp-1'],
          },
        ],
      });
      expect(where).toEqual({
        AND: [
          {
            messages: {
              none: {
                campaignId: { in: ['camp-1'] },
                direction: 'OUTBOUND',
                status: { in: REACHED_STATUSES },
              },
            },
          },
        ],
      });
    });

    it('empty campaignIds with negate:false (some) matches no one', () => {
      const where = toPrismaWhere({
        combinator: 'and',
        rules: [
          {
            kind: 'history',
            event: 'received',
            negate: false,
            campaignIds: [],
          },
        ],
      });
      expect(where).toEqual({
        AND: [
          {
            messages: {
              some: {
                campaignId: { in: [] },
                direction: 'OUTBOUND',
                status: { in: REACHED_STATUSES },
              },
            },
          },
        ],
      });
    });

    it('empty campaignIds with negate:true (none) does not filter anyone out', () => {
      const where = toPrismaWhere({
        combinator: 'and',
        rules: [
          { kind: 'history', event: 'received', negate: true, campaignIds: [] },
        ],
      });
      expect(where).toEqual({
        AND: [
          {
            messages: {
              none: {
                campaignId: { in: [] },
                direction: 'OUTBOUND',
                status: { in: REACHED_STATUSES },
              },
            },
          },
        ],
      });
    });

    // CRÍTICO (review F1 T2): um evento ainda não implementado NUNCA pode
    // virar `{}`. Em AND isso é neutro, mas dentro de um grupo OR o `{}` é
    // sempre-verdadeiro e colapsa `OR:[cond, {}]` para TRUE — casando a base
    // inteira silenciosamente, qualquer que seja `cond`. A única forma segura
    // é lançar, independente do combinator do grupo pai.
    // F2 T5 acendeu 'failed' (abaixo); 'replied' continua no throw (é F3).
    it.each(['replied'] as const)(
      'unimplemented event %s throws a ValidationError instead of resolving to a neutral {} clause',
      (event) => {
        expect(() =>
          toPrismaWhere({
            combinator: 'and',
            rules: [
              { kind: 'history', event, negate: false, campaignIds: ['c1'] },
            ],
          }),
        ).toThrow(ValidationError);
      },
    );

    it('inside an OR group, an unimplemented event throws instead of collapsing the OR to always-true', () => {
      // Antes do fix, historyRuleToPrisma devolvia {} para event:'replied', e
      // groupToPrisma produzia OR:[{city:'Manaus'}, {}] — um where sempre
      // verdadeiro que casa TODOS os contatos (inclusive quem não é de
      // Manaus), silenciosamente. Depois do fix, isso lança.
      let caught: unknown;
      try {
        toPrismaWhere({
          combinator: 'or',
          rules: [
            { field: 'city', op: 'eq', value: 'Manaus' },
            {
              kind: 'history',
              event: 'replied',
              campaignIds: ['c1'],
              negate: false,
            },
          ],
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ValidationError);
      expect((caught as ValidationError).detail).toMatch(
        /history filter event 'replied' is not supported yet/,
      );
      expect((caught as ValidationError).code).toBe(
        'campaign.history_event_not_supported',
      );
    });

    it('event:received keeps working normally (not affected by the throw added for replied)', () => {
      const where = toPrismaWhere({
        combinator: 'or',
        rules: [
          { field: 'city', op: 'eq', value: 'Manaus' },
          {
            kind: 'history',
            event: 'received',
            campaignIds: ['c1'],
            negate: false,
          },
        ],
      });
      expect(where).toEqual({
        OR: [
          { city: 'Manaus' },
          {
            messages: {
              some: {
                campaignId: { in: ['c1'] },
                direction: 'OUTBOUND',
                status: { in: REACHED_STATUSES },
              },
            },
          },
        ],
      });
    });
  });

  describe('history rule — event:failed', () => {
    it('negate:false becomes messages:{some:...} with status:FAILED, direction:OUTBOUND', () => {
      const where = toPrismaWhere({
        combinator: 'and',
        rules: [
          {
            kind: 'history',
            event: 'failed',
            negate: false,
            campaignIds: ['camp-1', 'camp-2'],
          },
        ],
      });
      expect(where).toEqual({
        AND: [
          {
            messages: {
              some: {
                campaignId: { in: ['camp-1', 'camp-2'] },
                direction: 'OUTBOUND',
                status: 'FAILED',
              },
            },
          },
        ],
      });
    });

    it('negate:true becomes messages:{none:...}', () => {
      const where = toPrismaWhere({
        combinator: 'and',
        rules: [
          {
            kind: 'history',
            event: 'failed',
            negate: true,
            campaignIds: ['camp-1'],
          },
        ],
      });
      expect(where).toEqual({
        AND: [
          {
            messages: {
              none: {
                campaignId: { in: ['camp-1'] },
                direction: 'OUTBOUND',
                status: 'FAILED',
              },
            },
          },
        ],
      });
    });

    it('with a failureReason, the clause carries the extra key', () => {
      const where = toPrismaWhere({
        combinator: 'and',
        rules: [
          {
            kind: 'history',
            event: 'failed',
            negate: false,
            campaignIds: ['camp-1'],
            failureReason: 'SEM_WHATSAPP',
          },
        ],
      });
      expect(where).toEqual({
        AND: [
          {
            messages: {
              some: {
                campaignId: { in: ['camp-1'] },
                direction: 'OUTBOUND',
                status: 'FAILED',
                failureReason: 'SEM_WHATSAPP',
              },
            },
          },
        ],
      });
    });

    it('without a failureReason, the clause has no failureReason key at all', () => {
      const where = toPrismaWhere({
        combinator: 'and',
        rules: [
          {
            kind: 'history',
            event: 'failed',
            negate: false,
            campaignIds: ['camp-1'],
          },
        ],
      });
      const clause = (
        (where as { AND: unknown[] }).AND[0] as {
          messages: { some: Record<string, unknown> };
        }
      ).messages.some;
      expect(clause).not.toHaveProperty('failureReason');
    });

    it('empty campaignIds with negate:false (some) matches no one', () => {
      const where = toPrismaWhere({
        combinator: 'and',
        rules: [
          { kind: 'history', event: 'failed', negate: false, campaignIds: [] },
        ],
      });
      expect(where).toEqual({
        AND: [
          {
            messages: {
              some: {
                campaignId: { in: [] },
                direction: 'OUTBOUND',
                status: 'FAILED',
              },
            },
          },
        ],
      });
    });

    it('empty campaignIds with negate:true (none) does not filter anyone out', () => {
      const where = toPrismaWhere({
        combinator: 'and',
        rules: [
          { kind: 'history', event: 'failed', negate: true, campaignIds: [] },
        ],
      });
      expect(where).toEqual({
        AND: [
          {
            messages: {
              none: {
                campaignId: { in: [] },
                direction: 'OUTBOUND',
                status: 'FAILED',
              },
            },
          },
        ],
      });
    });
  });
});

describe('toPrismaWhere — notIn null-safe em lastFailureReason (B.4)', () => {
  /**
   * ★ A PEGADINHA DO `NOT IN`, DE NOVO. `lastFailureReason NOT IN (…)` no
   * Postgres NÃO casa a linha cujo valor é NULL — e NULL é o estado de quase
   * toda a base. Sem o ramo `{ lastFailureReason: null }`, "excluir inválidos
   * confirmados" selecionaria SÓ quem já falhou por outro motivo: a campanha
   * sairia para umas poucas dezenas de pessoas em vez de treze mil.
   */
  it('emite o OR com o ramo NULL, e não um notIn pelado', () => {
    const where = toPrismaWhere({
      combinator: 'and',
      rules: [
        {
          field: 'lastFailureReason',
          op: 'notIn',
          value: ['SEM_WHATSAPP', 'TELEFONE_INVALIDO'],
        },
      ],
    });

    expect(where).toEqual({
      AND: [
        {
          OR: [
            { lastFailureReason: null },
            {
              lastFailureReason: {
                notIn: ['SEM_WHATSAPP', 'TELEFONE_INVALIDO'],
              },
            },
          ],
        },
      ],
    });
  });

  it('isNull/notNull continuam pelo caminho genérico', () => {
    const where = toPrismaWhere({
      combinator: 'and',
      rules: [{ field: 'lastFailureReason', op: 'isNull' }],
    });
    expect(where).toEqual({ AND: [{ lastFailureReason: null }] });
  });

  // O null-safe é DELIBERADAMENTE escopado: mudar `city notIn` agora alargaria
  // em silêncio a audiência de segmentos JÁ SALVOS, no meio de uma campanha
  // eleitoral. Este teste prende essa decisão para que ninguém a "conserte"
  // sem querer.
  it('NÃO muda o notIn dos outros campos (legado conhecido e intencional)', () => {
    const where = toPrismaWhere({
      combinator: 'and',
      rules: [{ field: 'city', op: 'notIn', value: ['Manaus'] }],
    });
    expect(where).toEqual({ AND: [{ city: { notIn: ['Manaus'] } }] });
  });
});

describe('toPrismaWhere — invariante de que extractIdWindow depende (campaigns.service.ts)', () => {
  /**
   * `extractIdWindow` (campaigns.service.ts, ~:199-209 — NÃO editado aqui)
   * olha só o ÚLTIMO elemento do `AND` de topo devolvido por `toPrismaWhere`
   * e o reconhece como a janela de `applyAudienceLimit`
   * (`{ AND: [where, { id: { lte: cutoffId } }] }`) SOMENTE porque tem uma
   * chave `id`.
   *
   * ★ Até 2026-08-25 essa heurística era protegida por `toPrismaWhere`, que
   * SEMPRE terminava o `AND` de topo em `{ optedOut: false }` — um elemento
   * de origem interna, garantidamente sem `id`. Essa garantia sumiu junto com
   * o guard de opt-out (decisão do cliente: opt-out deixou de ser filtro
   * automático do público). A invariante que sobra — e que este teste passa
   * a proteger — é a do CONTRATO: `filter.schema.ts#fieldSchema` não lista
   * `id` como campo filtrável, então não existe forma de uma `Rule` do
   * operador emitir uma chave `id` no `where` final, aplicada ou não a
   * `applyAudienceLimit`. Se esse contrato mudar, `extractIdWindow`
   * confundiria o filtro do operador com o corte do limite de audiência.
   */
  function lastTopLevelAndElement(
    where: Record<string, unknown>,
  ): Record<string, unknown> {
    const and = (where as { AND?: unknown[] }).AND;
    return Array.isArray(and)
      ? (and[and.length - 1] as Record<string, unknown>)
      : where;
  }

  it('filtro vazio: o where não tem chave id (nem AND de topo)', () => {
    const where = toPrismaWhere({ combinator: 'and', rules: [] });
    expect(where).toEqual({});
    expect(lastTopLevelAndElement(where)).not.toHaveProperty('id');
  });

  it('filtro usando todos os campos suportados pelo contrato: o último elemento do AND de topo não tem chave id', () => {
    const where = toPrismaWhere({
      combinator: 'and',
      rules: [
        { field: 'name', op: 'eq', value: 'João' },
        { field: 'city', op: 'eq', value: 'Manaus' },
        { field: 'group', op: 'eq', value: 'alunos' },
        { field: 'phoneE164', op: 'eq', value: '+5592999999999' },
        { field: 'tags', op: 'contains', value: 'vip' },
        { field: 'whatsappValid', op: 'eq', value: true },
        {
          field: 'lastFailureReason',
          op: 'in',
          value: ['SEM_WHATSAPP', 'TELEFONE_INVALIDO'],
        },
        {
          kind: 'history',
          event: 'received',
          negate: false,
          campaignIds: ['camp-1'],
        },
        {
          kind: 'history',
          event: 'failed',
          negate: true,
          campaignIds: ['camp-2'],
          failureReason: 'TELEFONE_INVALIDO',
        },
      ],
    });

    const last = lastTopLevelAndElement(where);
    expect(last).not.toHaveProperty('id');
    // O último elemento é a conversão do último rule (o nó history 'failed'),
    // não mais um guard interno fixo — é exatamente o ponto que mudou.
    expect(last).toEqual({
      messages: {
        none: {
          campaignId: { in: ['camp-2'] },
          direction: 'OUTBOUND',
          status: 'FAILED',
          failureReason: 'TELEFONE_INVALIDO',
        },
      },
    });
  });
});
