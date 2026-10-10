import { describe, expect, it } from 'vitest';
import { dateTime, demandUpdateErrorMessage } from './utils';
describe('dateTime', () => { it('apresenta instantes em Manaus sem deslocar a data civil', () => { expect(dateTime('2026-10-10T04:30:00.000Z')).toContain('10/10/2026'); }); });

describe('demandUpdateErrorMessage', () => {
  it('orienta recarregar após o conflito 409 sem reenviar a alteração', () => {
    expect(demandUpdateErrorMessage({ response: { status: 409 } })).toMatch(/alterada.*Atualize/i);
  });
});
