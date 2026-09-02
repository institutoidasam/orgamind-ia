import { describe, it, expect } from 'vitest';
import { normalizeToE164, brazilianPhoneVariants } from './phone.util';

describe('normalizeToE164', () => {
  it('normalizes Brazilian phone with formatting', () => {
    expect(normalizeToE164('(92) 98765-4321')).toBe('+5592987654321');
  });
  it('keeps already E.164', () => {
    expect(normalizeToE164('+5592987654321')).toBe('+5592987654321');
  });
  it('returns null for invalid', () => {
    expect(normalizeToE164('abc')).toBeNull();
  });
  it('strips spaces and symbols', () => {
    expect(normalizeToE164('92 98765 4321')).toBe('+5592987654321');
  });
  it('returns null for empty string', () => {
    expect(normalizeToE164('')).toBeNull();
  });
});

describe('brazilianPhoneVariants', () => {
  // The core fix for the WhatsApp 9th-digit problem: Evolution/Baileys returns
  // the JID for some BR mobiles WITHOUT the extra leading 9 (legacy 8-digit
  // subscriber), e.g. JID 559295550101 ↔ canonical contact +5592995550101.
  // To link a conversation to a contact we must compare BOTH forms.

  it('returns both the 9-digit and 8-digit forms for a BR mobile (9-digit input)', () => {
    expect(new Set(brazilianPhoneVariants('+5592995550101'))).toEqual(
      new Set(['+5592995550101', '+559295550101']),
    );
  });

  it('returns both forms for a BR mobile given the 8-digit (no-9) form', () => {
    expect(new Set(brazilianPhoneVariants('+559295550101'))).toEqual(
      new Set(['+559295550101', '+5592995550101']),
    );
  });

  it('always includes the input itself', () => {
    expect(brazilianPhoneVariants('+5592995550101')).toContain('+5592995550101');
  });

  it('does not invent a 9th digit for a landline (subscriber not starting with 9)', () => {
    // +559232145678 = DDD 92 + 8-digit landline starting with 3. Adding a 9
    // would be wrong, so only the input itself is returned.
    expect(brazilianPhoneVariants('+559232145678')).toEqual(['+559232145678']);
  });

  it('leaves non-Brazilian numbers untouched (single variant)', () => {
    expect(brazilianPhoneVariants('+14155552671')).toEqual(['+14155552671']);
  });

  it('returns the input unchanged for null/empty-ish input', () => {
    expect(brazilianPhoneVariants('')).toEqual(['']);
  });

  it('deduplicates so a number with no alternate form yields one entry', () => {
    const variants = brazilianPhoneVariants('+14155552671');
    expect(variants).toHaveLength(1);
  });

  // ────────────────────────────────────────────────────────────────────────────
  // O 9º DÍGITO NÃO É "O NÚMERO COMEÇA COM 9".
  //
  // O Brasil PREFIXOU um 9 aos celulares em 2012. A forma legada de 8 dígitos é
  // a moderna MENOS esse 9 da frente — e o que sobra começa com o dígito
  // ORIGINAL do celular, que a Anatel aloca em 6, 7, 8 ou 9. NÃO só 9.
  //
  // O código antigo só reconhecia a forma legada quando ela começava com 9, ou
  // seja, só os celulares `9 9…`. Todo `9 8…`, `9 7…`, `9 6…` — a MAIORIA da
  // base — não gerava variante, e o inbound que o WhatsApp reportou na forma
  // legada não casava com o contato da planilha. O caso (a) abaixo é real: veio
  // de produção, gerou contato duplicado.
  // ────────────────────────────────────────────────────────────────────────────

  it('(a) casa o celular 98… nas duas formas — o caso que duplicou contato em produção', () => {
    // Contato na base: +5592986550101. Inbound reportado: +559286550101.
    expect(new Set(brazilianPhoneVariants('+5592986550101'))).toEqual(
      new Set(['+5592986550101', '+559286550101']),
    );
    expect(new Set(brazilianPhoneVariants('+559286550101'))).toEqual(
      new Set(['+559286550101', '+5592986550101']),
    );
  });

  it('(b) não quebra o celular 99… que já funcionava', () => {
    expect(new Set(brazilianPhoneVariants('+5592995550101'))).toEqual(
      new Set(['+5592995550101', '+559295550101']),
    );
    expect(new Set(brazilianPhoneVariants('+559295550101'))).toEqual(
      new Set(['+559295550101', '+5592995550101']),
    );
  });

  it('(c) prefixa o 9 no celular legado que começa com 7', () => {
    expect(brazilianPhoneVariants('+559276543210')).toContain('+5592976543210');
  });

  it('(d) prefixa o 9 no celular legado que começa com 6', () => {
    expect(brazilianPhoneVariants('+559266543210')).toContain('+5592966543210');
  });

  it('(e) NUNCA prefixa 9 num FIXO — inventaria um número que não existe', () => {
    // 8 dígitos começando com 3 = fixo. Idem 2, 4 e 5.
    expect(brazilianPhoneVariants('+559232145678')).toEqual(['+559232145678']);
    expect(brazilianPhoneVariants('+559221145678')).toEqual(['+559221145678']);
    expect(brazilianPhoneVariants('+559241145678')).toEqual(['+559241145678']);
    expect(brazilianPhoneVariants('+559251145678')).toEqual(['+559251145678']);
  });

  it('(e2) não trata como celular o 9 dígitos cujo miolo é de fixo', () => {
    // 9 + 8 dígitos começando com 3 não é celular: tirar o 9 daria um fixo.
    // Gerar a variante aqui seria inventar um número de outra pessoa.
    expect(brazilianPhoneVariants('+5592932145678')).toEqual(['+5592932145678']);
  });

  it('(f) é idempotente: a variante da variante contém o número original', () => {
    for (const original of [
      '+5592986550101',
      '+5592995550101',
      '+559276543210',
      '+559266543210',
    ]) {
      const alternate = brazilianPhoneVariants(original)[1];
      expect(alternate, `${original} deveria gerar uma variante`).toBeDefined();
      expect(brazilianPhoneVariants(alternate)).toContain(original);
    }
  });

  it('(g) não inventa variante para número não-BR', () => {
    expect(brazilianPhoneVariants('+15551234567')).toEqual(['+15551234567']);
  });
});
