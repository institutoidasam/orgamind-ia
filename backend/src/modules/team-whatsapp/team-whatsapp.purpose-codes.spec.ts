import { describe, expect, it } from 'vitest';
import { TeamSchedulePolicy } from '@prisma/client';
import {
  teamAudienceBaseSchema,
  teamPurposeSchema,
  teamSchedulePolicySchema,
} from '../../schemas/contracts/team-whatsapp.schema';
import {
  fromDbBase,
  fromDbPolicy,
  fromDbPurpose,
  toDbBase,
  toDbPolicy,
  toDbPurpose,
} from './team-whatsapp.purpose-codes';

describe('política do agendado gravada (Lote G, DG6)', () => {
  it.each(teamSchedulePolicySchema.options)(
    'política %s: banco em maiúsculas e volta igual',
    (policy) => {
      expect(toDbPolicy(policy)).toBe(policy.toUpperCase());
      expect(fromDbPolicy(toDbPolicy(policy))).toBe(policy);
    },
  );
});

describe('conversão finalidade, base e política (CF8)', () => {
  it.each(teamPurposeSchema.options)(
    'finalidade %s: banco em maiúsculas e volta igual',
    (purpose) => {
      expect(toDbPurpose(purpose)).toBe(purpose.toUpperCase());
      expect(fromDbPurpose(toDbPurpose(purpose))).toBe(purpose);
    },
  );

  it.each(teamAudienceBaseSchema.options)(
    'base %s: banco em maiúsculas e volta igual',
    (base) => {
      expect(toDbBase(base)).toBe(base.toUpperCase());
      expect(fromDbBase(toDbBase(base))).toBe(base);
    },
  );

  // O F só lê a política (GF13: o agendado grava nulo); a ida fica para o Lote G.
  it.each(Object.values(TeamSchedulePolicy))(
    'política %s: lida do banco vira o código da API',
    (policy) => {
      const api = fromDbPolicy(policy);
      expect(api).toBe(policy.toLowerCase());
      expect(teamSchedulePolicySchema.options).toContain(api);
    },
  );

  it('coluna nula (envio antigo) volta nula, sem valor assumido', () => {
    expect(fromDbPurpose(null)).toBeNull();
    expect(fromDbBase(null)).toBeNull();
    expect(fromDbPolicy(null)).toBeNull();
  });
});

describe('valor do banco sem mapa (enum novo ou dado corrompido)', () => {
  const unknown = 'VALOR_NOVO' as never;

  it.each([
    ['finalidade', () => fromDbPurpose(unknown)],
    ['base', () => fromDbBase(unknown)],
    ['política', () => fromDbPolicy(unknown)],
  ])(
    '%s: lança erro com o valor recebido, sem devolver undefined',
    (_k, run) => {
      expect(run).toThrow('VALOR_NOVO');
    },
  );
});
