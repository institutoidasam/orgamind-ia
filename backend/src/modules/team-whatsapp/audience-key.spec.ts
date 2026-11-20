import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  audienceKey,
  canonicalAudience,
  deriveAudienceSecret,
  type AudienceKeyInput,
} from './audience-key';

// Segredo fictício de teste (o JWT_SECRET real exige 32 caracteres ou mais).
const JWT = 'segredo-ficticio-de-teste-com-mais-de-32-caracteres';
const SECRET = deriveAudienceSecret(JWT);
const PHONE_A = '+5592991110001';
const PHONE_B = '+5592991110002';

type Rule = AudienceKeyInput['rule'];
type People = Partial<Pick<AudienceKeyInput, 'receiving' | 'excluded'>>;

const R1 = {
  userId: 'u-1',
  sectorId: 'sec-1',
  shiftId: 'sh-1',
  phone: PHONE_A,
};
const R2 = { userId: 'u-2', sectorId: 'sec-2', shiftId: null, phone: PHONE_B };
const OFF = { userId: 'u-3', sectorId: 'sec-1', reason: 'day_off' } as const;
const VAC = { userId: 'u-4', sectorId: 'sec-2', reason: 'vacation' } as const;
const EXTRA = { userId: 'u-5', sectorId: 'sec-1', shiftId: null };

/** Uma mudança no público por item; cada uma tem de mudar a impressão. */
const PEOPLE_VARIANTS: [string, People][] = [
  [
    'quem recebe a mais',
    { receiving: [R1, R2, { ...EXTRA, phone: '+5592991110005' }] },
  ],
  [
    'excluído a mais',
    { excluded: [OFF, VAC, { ...EXTRA, reason: 'no_phone' }] },
  ],
  ['motivo diferente', { excluded: [{ ...OFF, reason: 'vacation' }, VAC] }],
  ['setor de quem recebe', { receiving: [{ ...R1, sectorId: 'sec-2' }, R2] }],
  ['setor de excluído', { excluded: [OFF, { ...VAC, sectorId: 'sec-1' }] }],
  ['turno de quem recebe', { receiving: [R1, { ...R2, shiftId: 'sh-1' }] }],
  [
    'telefone de quem recebe',
    { receiving: [R1, { ...R2, phone: '+5592991110003' }] },
  ],
  [
    'de quem recebe para excluído',
    { receiving: [R1], excluded: [OFF, VAC, { ...R2, reason: 'no_phone' }] },
  ],
];

function input(rule: Partial<Rule> = {}): AudienceKeyInput {
  return {
    rule: {
      purpose: 'meeting',
      base: 'on_duty',
      includeOff: false,
      date: '2026-11-20',
      sectorIds: ['sec-1', 'sec-2'],
      shiftIds: ['sh-1'],
      levelIds: ['lv-1'],
      withoutLevel: false,
      userIds: null,
      ...rule,
    },
    receiving: [R1, R2],
    excluded: [OFF, VAC],
  };
}

const keyOf = (value: AudienceKeyInput): string => audienceKey(value, SECRET);

describe('audienceKey — canonização', () => {
  it('mesma entrada em outra ordem dá a mesma impressão', () => {
    const base = input({ userIds: ['u-1', 'u-2'] });
    const shuffled: AudienceKeyInput = {
      excluded: [...base.excluded].reverse(),
      receiving: [
        { phone: PHONE_B, shiftId: null, sectorId: 'sec-2', userId: 'u-2' },
        { phone: PHONE_A, shiftId: 'sh-1', sectorId: 'sec-1', userId: 'u-1' },
      ],
      rule: {
        ...base.rule,
        sectorIds: ['sec-2', 'sec-1', 'sec-2'],
        shiftIds: ['sh-1', 'sh-1'],
        levelIds: ['lv-1', 'lv-1'],
        userIds: ['u-2', 'u-1', 'u-2'],
      },
    };
    expect(keyOf(shuffled)).toBe(keyOf(base));
    // Mesmo userId repetido: o texto da linha desempata a ordem.
    const twice = { ...R1, sectorId: 'sec-2' };
    expect(keyOf({ ...base, receiving: [R1, twice] })).toBe(
      keyOf({ ...base, receiving: [twice, R1] }),
    );
  });

  it('telefone de excluído não entra', () => {
    const base = input();
    const otherPhone = '+5592991110009';
    const withPhone: AudienceKeyInput = {
      ...base,
      excluded: base.excluded.map((e) => ({ ...e, phone: otherPhone })),
    };
    expect(keyOf(withPhone)).toBe(keyOf(base));
    expect(canonicalAudience(withPhone)).not.toContain(otherPhone);
  });
});

describe('audienceKey — o público muda a impressão', () => {
  it('muda com pessoa a mais, motivo diferente, setor diferente ou telefone diferente de quem recebe', () => {
    const base = keyOf(input());
    for (const [name, people] of PEOPLE_VARIANTS) {
      expect(keyOf({ ...input(), ...people }), name).not.toBe(base);
    }
  });

  it('aceite 16 (parte pura): telefone trocado muda a impressão', () => {
    const preview = input();
    const [first, second] = preview.receiving;
    const confirm: AudienceKeyInput = {
      ...preview,
      receiving: [{ ...first, phone: '+5592991110007' }, second],
    };
    expect(keyOf(confirm)).not.toBe(keyOf(preview));
    expect(keyOf(input())).toBe(keyOf(preview));
  });
});

describe('audienceKey — a regra muda a impressão', () => {
  it('muda com a regra: finalidade, base, folga, data, turnos, níveis, seleção', () => {
    const base = keyOf(input());
    const variants: [string, Partial<Rule>][] = [
      ['finalidade', { purpose: 'alignment' }],
      ['base', { base: 'assigned' }],
      ['folga', { includeOff: true }],
      ['data', { date: '2026-11-21' }],
      ['setores', { sectorIds: ['sec-1'] }],
      ['turnos', { shiftIds: ['sh-2'] }],
      ['todos os turnos', { shiftIds: null }],
      ['níveis', { levelIds: ['lv-2'] }],
      ['sem nível', { withoutLevel: true }],
      ['seleção', { userIds: ['u-1', 'u-2'] }],
    ];
    for (const [name, rule] of variants) {
      expect(keyOf(input(rule)), name).not.toBe(base);
    }
    // null explícito: "todos" não se confunde com lista vazia.
    expect(keyOf(input({ shiftIds: [] }))).not.toBe(
      keyOf(input({ shiftIds: null })),
    );
    expect(keyOf(input({ userIds: [] }))).not.toBe(
      keyOf(input({ userIds: null })),
    );
  });
});

describe('audienceKey — segredo', () => {
  it('a impressão não é reproduzível sem a chave: SHA-256 puro do mesmo JSON dá outro valor; o texto não contém o telefone', () => {
    const value = input();
    const key = keyOf(value);
    const json = canonicalAudience(value);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key).toBe(createHmac('sha256', SECRET).update(json).digest('hex'));
    expect(createHash('sha256').update(json).digest('hex')).not.toBe(key);
    expect(audienceKey(value, deriveAudienceSecret(`${JWT}-outro`))).not.toBe(
      key,
    );
    for (const phone of [PHONE_A, PHONE_B]) {
      expect(key).not.toContain(phone.slice(1));
    }
    expect(() => audienceKey(value, Buffer.alloc(0))).toThrow();
  });

  it('deriveAudienceSecret depende do segredo', () => {
    const derived = deriveAudienceSecret(JWT);
    expect(derived).toHaveLength(32);
    expect(deriveAudienceSecret(JWT).equals(derived)).toBe(true);
    expect(deriveAudienceSecret(`${JWT}-outro`).equals(derived)).toBe(false);
    // Vetor conhecido de HMAC-SHA256(JWT, 'team-audience-key:v1') (CF7).
    expect(derived.toString('hex')).toBe(
      '19624fb7b03cc8bca6e6c6ac39aceed6c25f2519dd6f6c29e39016d4c089b8ad',
    );
    expect(() => deriveAudienceSecret('')).toThrow();
  });
});
