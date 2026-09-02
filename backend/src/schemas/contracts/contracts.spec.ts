import { describe, it, expect } from 'vitest';
import { dashboardMetricsSchema } from './metrics.schema';
import {
  extractTemplateVariables,
  listConfigSchema,
  buttonsConfigSchema,
  pollConfigSchema,
  createTemplateSchema,
} from './template.schema';
import { scheduleConfigSchema } from './schedule.schema';
import { filterGroupSchema } from './filter.schema';
import {
  connectionProfileSchema,
  connectionEventSchema,
  enrichedConnectionInfoSchema,
} from './whatsapp.schema';

describe('dashboardMetricsSchema', () => {
  const validMetricBlock = {
    count: 12,
    meta: '+3 since last week',
    sparkline: [1, 2, 3, 4, 5, 6, 7],
  };

  const validPayload = {
    activeCampaigns: validMetricBlock,
    activeContacts: validMetricBlock,
    approvedTemplates: validMetricBlock,
    deliveryRate7d: { ...validMetricBlock, count: 95 },
    liveFlow: { queued: 1, sent: 2, delivered: 3, read: 4, failed: 0 },
  };

  it('accepts a fully populated payload', () => {
    expect(() => dashboardMetricsSchema.parse(validPayload)).not.toThrow();
  });

  it('rejects sparkline length !== 7', () => {
    const bad = {
      ...validPayload,
      activeCampaigns: { ...validMetricBlock, sparkline: [1, 2, 3] },
    };
    const result = dashboardMetricsSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it('rejects sparkline of 8 entries too', () => {
    const bad = {
      ...validPayload,
      activeContacts: {
        ...validMetricBlock,
        sparkline: [1, 2, 3, 4, 5, 6, 7, 8],
      },
    };
    expect(dashboardMetricsSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects when liveFlow is missing a field', () => {
    const bad = {
      ...validPayload,
      liveFlow: { queued: 1, sent: 2, delivered: 3, read: 4 },
    };
    expect(dashboardMetricsSchema.safeParse(bad).success).toBe(false);
  });
});

describe('extractTemplateVariables', () => {
  it('returns named variables in first-seen order', () => {
    expect(extractTemplateVariables('Olá {{nome}} de {{cidade}}')).toEqual([
      'nome',
      'cidade',
    ]);
  });

  it('handles positional + named together and dedupes', () => {
    expect(
      extractTemplateVariables(
        'Olá {{nome}} de {{cidade}} com {{1}} {{nome}}',
      ),
    ).toEqual(['nome', 'cidade', '1']);
  });

  it('does NOT extract tokens with inner whitespace (interpolation needs a literal match)', () => {
    // Runtime interpolation replaces the literal `{{key}}` (no inner spaces),
    // so a token like `{{ nome }}` could never be substituted. Extraction must
    // only surface tokens that interpolation can actually replace, otherwise
    // the variable map carries a name whose placeholder stays in the message.
    expect(extractTemplateVariables('{{ nome }}')).toEqual([]);
    expect(extractTemplateVariables('{{nome }}')).toEqual([]);
    expect(extractTemplateVariables('{{ nome}}')).toEqual([]);
    expect(extractTemplateVariables('{{  nome  }}')).toEqual([]);
  });

  it('extracts only literal {{key}} tokens, and those round-trip through literal interpolation', () => {
    const body = 'Olá {{nome}} de {{cidade}}, com {{ ignorado }}';
    const vars = extractTemplateVariables(body);
    expect(vars).toEqual(['nome', 'cidade']);
    // Every extracted name must have a literal `{{name}}` occurrence that
    // interpolation (replaceAll(`{{${k}}}`, v)) can substitute.
    for (const k of vars) {
      expect(body.includes(`{{${k}}}`)).toBe(true);
    }
  });

  it('returns [] for body with no placeholders', () => {
    expect(extractTemplateVariables('Hello world')).toEqual([]);
  });

  it('returns [] for empty body', () => {
    expect(extractTemplateVariables('')).toEqual([]);
  });
});

describe('createTemplateSchema — metaName casing', () => {
  const base = {
    language: 'pt_BR',
    body: 'Hello',
    category: 'UTILITY' as const,
    kind: 'TEXT' as const,
  };

  it('accepts a lowercase metaName', () => {
    expect(
      createTemplateSchema.safeParse({ ...base, metaName: 'boas_vindas_01' })
        .success,
    ).toBe(true);
  });

  it('rejects an uppercase metaName (Meta names are lowercase; key is case-sensitive)', () => {
    expect(
      createTemplateSchema.safeParse({ ...base, metaName: 'Boas_Vindas' })
        .success,
    ).toBe(false);
    expect(
      createTemplateSchema.safeParse({ ...base, metaName: 'WELCOME' }).success,
    ).toBe(false);
  });
});

describe('pollConfigSchema — selectableOptionsCount bound', () => {
  it('rejects selectableOptionsCount greater than the number of options', () => {
    const cfg = {
      question: 'q?',
      options: ['a', 'b'],
      selectableOptionsCount: 3,
    };
    expect(pollConfigSchema.safeParse(cfg).success).toBe(false);
  });

  it('accepts selectableOptionsCount equal to options.length', () => {
    const cfg = {
      question: 'q?',
      options: ['a', 'b', 'c'],
      selectableOptionsCount: 3,
    };
    expect(pollConfigSchema.safeParse(cfg).success).toBe(true);
  });
});

describe('listConfigSchema', () => {
  const valid = {
    title: 'Pick one',
    description: 'Below',
    buttonText: 'View',
    sections: [
      {
        title: 'A',
        rows: [{ rowId: 'r1', title: 'Option 1' }],
      },
    ],
  };

  it('accepts a valid LIST config', () => {
    expect(() => listConfigSchema.parse(valid)).not.toThrow();
  });

  it('rejects empty sections array', () => {
    const bad = { ...valid, sections: [] };
    expect(listConfigSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a section with empty rows array', () => {
    const bad = {
      ...valid,
      sections: [{ title: 'A', rows: [] }],
    };
    expect(listConfigSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects when title is empty', () => {
    expect(listConfigSchema.safeParse({ ...valid, title: '' }).success).toBe(
      false,
    );
  });

  it('accepts optional footerText', () => {
    expect(
      listConfigSchema.parse({ ...valid, footerText: 'fine print' }).footerText,
    ).toBe('fine print');
  });
});

describe('buttonsConfigSchema', () => {
  const button = (id: string) => ({ buttonId: id, title: id });

  it('accepts up to 3 buttons', () => {
    const cfg = {
      description: 'Do something',
      buttons: [button('a'), button('b'), button('c')],
    };
    expect(() => buttonsConfigSchema.parse(cfg)).not.toThrow();
  });

  it('rejects 4 buttons', () => {
    const cfg = {
      description: 'Do something',
      buttons: [button('a'), button('b'), button('c'), button('d')],
    };
    expect(buttonsConfigSchema.safeParse(cfg).success).toBe(false);
  });

  it('rejects 0 buttons', () => {
    expect(
      buttonsConfigSchema.safeParse({
        description: 'Hi',
        buttons: [],
      }).success,
    ).toBe(false);
  });

  it('rejects empty description', () => {
    expect(
      buttonsConfigSchema.safeParse({
        description: '',
        buttons: [button('a')],
      }).success,
    ).toBe(false);
  });
});

describe('pollConfigSchema', () => {
  it('accepts 2..12 options', () => {
    const cfg = {
      question: 'q?',
      options: ['a', 'b'],
      selectableOptionsCount: 1,
    };
    expect(() => pollConfigSchema.parse(cfg)).not.toThrow();

    const cfg12 = {
      ...cfg,
      options: Array.from({ length: 12 }, (_, i) => `opt-${i}`),
    };
    expect(() => pollConfigSchema.parse(cfg12)).not.toThrow();
  });

  it('rejects 1 option', () => {
    const cfg = {
      question: 'q?',
      options: ['only'],
    };
    expect(pollConfigSchema.safeParse(cfg).success).toBe(false);
  });

  it('rejects 13 options', () => {
    const cfg = {
      question: 'q?',
      options: Array.from({ length: 13 }, (_, i) => `o${i}`),
    };
    expect(pollConfigSchema.safeParse(cfg).success).toBe(false);
  });

  it('defaults selectableOptionsCount to 1', () => {
    const cfg = pollConfigSchema.parse({
      question: 'q?',
      options: ['a', 'b'],
    });
    expect(cfg.selectableOptionsCount).toBe(1);
  });
});

describe('scheduleConfigSchema', () => {
  it('accepts IMMEDIATE with no extras', () => {
    expect(() => scheduleConfigSchema.parse({ type: 'IMMEDIATE' })).not.toThrow();
  });

  it('accepts ONCE_AT with an ISO datetime and transforms to a Date', () => {
    const parsed = scheduleConfigSchema.parse({
      type: 'ONCE_AT',
      runAt: '2030-01-01T12:00:00Z',
    });
    expect(parsed.type).toBe('ONCE_AT');
    if (parsed.type === 'ONCE_AT') {
      expect(parsed.runAt).toBeInstanceOf(Date);
      expect(parsed.runAt.toISOString()).toBe('2030-01-01T12:00:00.000Z');
    }
  });

  it('rejects ONCE_AT without runAt', () => {
    expect(
      scheduleConfigSchema.safeParse({ type: 'ONCE_AT' } as any).success,
    ).toBe(false);
  });

  it('rejects ONCE_AT with malformed runAt', () => {
    expect(
      scheduleConfigSchema.safeParse({
        type: 'ONCE_AT',
        runAt: 'not-a-date',
      }).success,
    ).toBe(false);
  });

  it('accepts DAILY_AT with HH:mm', () => {
    expect(
      scheduleConfigSchema.parse({ type: 'DAILY_AT', time: '14:00' }),
    ).toEqual({ type: 'DAILY_AT', time: '14:00' });
  });

  it('rejects DAILY_AT with invalid time format', () => {
    expect(
      scheduleConfigSchema.safeParse({ type: 'DAILY_AT', time: '24:00' })
        .success,
    ).toBe(false);
    expect(
      scheduleConfigSchema.safeParse({ type: 'DAILY_AT', time: '8:00' }).success,
    ).toBe(false);
  });

  it('accepts WEEKLY with weekdays + time', () => {
    expect(() =>
      scheduleConfigSchema.parse({
        type: 'WEEKLY',
        time: '09:00',
        weekdays: [1, 3, 5],
      }),
    ).not.toThrow();
  });

  it('rejects WEEKLY with empty weekdays', () => {
    expect(
      scheduleConfigSchema.safeParse({
        type: 'WEEKLY',
        time: '09:00',
        weekdays: [],
      }).success,
    ).toBe(false);
  });

  it('rejects WEEKLY weekdays out of range', () => {
    expect(
      scheduleConfigSchema.safeParse({
        type: 'WEEKLY',
        time: '09:00',
        weekdays: [7],
      }).success,
    ).toBe(false);
  });

  it('accepts INTERVAL with everyMinutes ≥5', () => {
    expect(() =>
      scheduleConfigSchema.parse({ type: 'INTERVAL', everyMinutes: 5 }),
    ).not.toThrow();
  });

  it('rejects INTERVAL with everyMinutes <5', () => {
    expect(
      scheduleConfigSchema.safeParse({ type: 'INTERVAL', everyMinutes: 4 })
        .success,
    ).toBe(false);
  });

  it('rejects INTERVAL exceeding 30 days in minutes', () => {
    expect(
      scheduleConfigSchema.safeParse({
        type: 'INTERVAL',
        everyMinutes: 60 * 24 * 31,
      }).success,
    ).toBe(false);
  });
});

describe('filterGroupSchema', () => {
  it('accepts an empty group', () => {
    expect(() =>
      filterGroupSchema.parse({ combinator: 'and', rules: [] }),
    ).not.toThrow();
  });

  it('accepts a group with simple rules', () => {
    expect(() =>
      filterGroupSchema.parse({
        combinator: 'and',
        rules: [{ field: 'name', op: 'contains', value: 'Maria' }],
      }),
    ).not.toThrow();
  });

  it('accepts nested groups (recursive)', () => {
    const parsed = filterGroupSchema.parse({
      combinator: 'and',
      rules: [
        { field: 'city', op: 'eq', value: 'Manaus' },
        {
          combinator: 'or',
          rules: [
            { field: 'group', op: 'eq', value: 'A' },
            { field: 'group', op: 'eq', value: 'B' },
          ],
        },
      ],
    });
    expect(parsed.rules).toHaveLength(2);
  });

  it('rejects an unknown field', () => {
    expect(
      filterGroupSchema.safeParse({
        combinator: 'and',
        rules: [{ field: 'nope', op: 'eq', value: 'x' } as any],
      }).success,
    ).toBe(false);
  });

  it('rejects an unknown op', () => {
    expect(
      filterGroupSchema.safeParse({
        combinator: 'and',
        rules: [{ field: 'name', op: 'matches' as any, value: 'x' }],
      }).success,
    ).toBe(false);
  });

  it('rejects an unknown combinator', () => {
    expect(
      filterGroupSchema.safeParse({
        combinator: 'xor' as any,
        rules: [],
      }).success,
    ).toBe(false);
  });

  it('accepts unary ops without a value', () => {
    expect(() =>
      filterGroupSchema.parse({
        combinator: 'and',
        rules: [{ field: 'group', op: 'isNull' }],
      }),
    ).not.toThrow();
  });

  it('rejects optedOut as a filter field — operators must not opt-in opt-outs', () => {
    expect(
      filterGroupSchema.safeParse({
        combinator: 'and',
        rules: [{ field: 'optedOut', op: 'eq', value: true }],
      }).success,
    ).toBe(false);
  });

  it('accepts whatsappValid as a filter field', () => {
    expect(() =>
      filterGroupSchema.parse({
        combinator: 'and',
        rules: [{ field: 'whatsappValid', op: 'eq', value: true }],
      }),
    ).not.toThrow();
  });

  it('accepts array values for in/notIn', () => {
    expect(() =>
      filterGroupSchema.parse({
        combinator: 'and',
        rules: [{ field: 'tags', op: 'in', value: ['vip', 'priority'] }],
      }),
    ).not.toThrow();
  });
});

describe('enrichedConnectionInfoSchema', () => {
  const validProfile = {
    ownerJid: '5592999887766@s.whatsapp.net',
    phoneE164: '+5592999887766',
    profileName: 'Test User',
    profilePictureUrl: null,
  };

  const validEvent = {
    state: 'open' as const,
    reasonCode: null,
    occurredAt: '2026-05-20T10:00:00Z',
  };

  const validPayload = {
    state: 'open' as const,
    provider: 'evolution' as const,
    profile: validProfile,
    connectedSince: '2026-05-20T10:00:00Z',
    health: 'healthy' as const,
    recentEvents: [validEvent],
  };

  it('accepts a fully populated evolution response', () => {
    expect(() => enrichedConnectionInfoSchema.parse(validPayload)).not.toThrow();
  });

  it('accepts meta provider with profile=null and empty recentEvents', () => {
    const metaPayload = {
      state: 'open' as const,
      provider: 'meta' as const,
      profile: null,
      connectedSince: null,
      health: 'healthy' as const,
      recentEvents: [],
    };
    expect(() => enrichedConnectionInfoSchema.parse(metaPayload)).not.toThrow();
  });

  it('rejects invalid health value', () => {
    const bad = { ...validPayload, health: 'unknown' };
    expect(enrichedConnectionInfoSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects invalid state value', () => {
    const bad = { ...validPayload, state: 'disconnected' };
    expect(enrichedConnectionInfoSchema.safeParse(bad).success).toBe(false);
  });

  it('connectionProfileSchema rejects missing required fields', () => {
    const bad = { ownerJid: 'jid@s.whatsapp.net' }; // missing 3 fields
    expect(connectionProfileSchema.safeParse(bad).success).toBe(false);
  });

  it('connectionEventSchema rejects invalid state', () => {
    const bad = { state: 'disconnected', reasonCode: null, occurredAt: '2026-05-20T10:00:00Z' };
    expect(connectionEventSchema.safeParse(bad).success).toBe(false);
  });

  // be-bootstrap-8: whatsapp.schema migrated off the deprecated
  // z.string().datetime() to the zod v4 z.iso.datetime() form. These lock in
  // the datetime validation so the cleanup can't silently loosen it.
  it('connectionEventSchema rejects a non-datetime occurredAt', () => {
    const bad = { state: 'open', reasonCode: null, occurredAt: 'not-a-date' };
    expect(connectionEventSchema.safeParse(bad).success).toBe(false);
  });

  it('connectionEventSchema accepts a valid ISO datetime occurredAt', () => {
    const ok = { state: 'open', reasonCode: null, occurredAt: '2026-05-20T10:00:00Z' };
    expect(connectionEventSchema.safeParse(ok).success).toBe(true);
  });

  it('enrichedConnectionInfoSchema rejects a non-datetime connectedSince', () => {
    const bad = { ...validPayload, connectedSince: 'yesterday' };
    expect(enrichedConnectionInfoSchema.safeParse(bad).success).toBe(false);
  });
});
