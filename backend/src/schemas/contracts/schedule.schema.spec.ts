import { describe, it, expect } from 'vitest';
import { timezoneSchema, TIMEZONE_DEFAULT } from './schedule.schema';

describe('timezoneSchema', () => {
  it('accepts valid IANA timezones', () => {
    expect(timezoneSchema.parse('America/Sao_Paulo')).toBe('America/Sao_Paulo');
    expect(timezoneSchema.parse('America/Manaus')).toBe('America/Manaus');
    expect(timezoneSchema.parse('UTC')).toBe('UTC');
    expect(timezoneSchema.parse('Europe/Lisbon')).toBe('Europe/Lisbon');
  });

  /**
   * C2 — o default era `America/Sao_Paulo`, mas o IDASAM (e quem opera o orgamind)
   * está em MANAUS (UTC-4, sem horário de verão). Toda campanha agendada para
   * "09:00" disparava às 08:00 locais — uma hora mais cedo, todo dia.
   */
  it('defaults to America/Manaus (UTC-4) — o fuso de quem opera o orgamind', () => {
    expect(TIMEZONE_DEFAULT).toBe('America/Manaus');
    expect(timezoneSchema.parse(undefined)).toBe('America/Manaus');
  });

  /**
   * O fuso é gravado POR CAMPANHA (`Campaign.timezone`), então o novo default só
   * vale para campanhas NOVAS: uma campanha que já nasceu com America/Sao_Paulo
   * continua com ele — o parse nunca reescreve um valor explícito.
   */
  it('não reescreve um fuso já informado (campanha antiga mantém o dela)', () => {
    expect(timezoneSchema.parse('America/Sao_Paulo')).toBe('America/Sao_Paulo');
  });

  it('rejects non-existent / garbage timezones', () => {
    expect(timezoneSchema.safeParse('Not/AZone').success).toBe(false);
    expect(timezoneSchema.safeParse('Mars/Phobos').success).toBe(false);
    expect(timezoneSchema.safeParse('xxxxxxxx').success).toBe(false);
    expect(timezoneSchema.safeParse('').success).toBe(false);
  });

  it('rejects an over-long string (length cap)', () => {
    expect(timezoneSchema.safeParse('A'.repeat(100)).success).toBe(false);
  });
});
