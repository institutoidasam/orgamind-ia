import { describe, it, expect } from 'vitest';
import { isSameBrazilianSubscriber } from './br-ninth-digit';

describe('isSameBrazilianSubscriber', () => {
  it('aceita o par exato do incidente: 13 dígitos vs o canônico de 12', () => {
    // Medido em produção 2026-08-07: 5592995550101 nunca entregou;
    // 559295550101 entregou em 15s. É o MESMO assinante.
    expect(isSameBrazilianSubscriber('5592995550101', '559295550101')).toBe(
      true,
    );
    expect(isSameBrazilianSubscriber('559295550101', '5592995550101')).toBe(
      true,
    );
  });

  it('aceita igualdade exata e tolera formatação', () => {
    expect(
      isSameBrazilianSubscriber('+55 92 99555-0101', '5592995550101'),
    ).toBe(true);
    expect(isSameBrazilianSubscriber('5511987654321', '5511987654321')).toBe(
      true,
    );
  });

  it('RECUSA número diferente — é o que impede disparar para um estranho', () => {
    // Mesmo DDD, assinante diferente.
    expect(isSameBrazilianSubscriber('5592995550101', '559295550102')).toBe(
      false,
    );
    // DDD diferente (o caso que apareceu de verdade: pedi 92, veio 11).
    expect(isSameBrazilianSubscriber('5592995550101', '551195550101')).toBe(
      false,
    );
    // País diferente.
    expect(isSameBrazilianSubscriber('5592995550101', '119295550101')).toBe(
      false,
    );
  });

  it('não confunde "tirar o 9" com "trocar o primeiro dígito"', () => {
    // 8-dígitos que NÃO é o 9-dígitos sem o 9 inicial.
    expect(isSameBrazilianSubscriber('5592995550101', '559285550101')).toBe(
      false,
    );
  });

  it('FIXO não ganha variante com 9 — o "9+fixo" é celular de OUTRA pessoa', () => {
    // Assinante começando em 2-5 é fixo. `3234-5678` e `9 3234-5678` são
    // pessoas diferentes; aceitar o par mandaria a campanha para um terceiro.
    expect(isSameBrazilianSubscriber('559232345678', '5592932345678')).toBe(
      false,
    );
    expect(isSameBrazilianSubscriber('559222345678', '5592922345678')).toBe(
      false,
    );
    // Móvel (6-9) continua valendo — é o caso real do incidente.
    expect(isSameBrazilianSubscriber('559295550101', '5592995550101')).toBe(
      true,
    );
    expect(isSameBrazilianSubscriber('559265550101', '5592965550101')).toBe(
      true,
    );
  });

  it('fora do Brasil exige igualdade EXATA (nenhuma tolerância inventada)', () => {
    expect(isSameBrazilianSubscriber('12025550100', '2025550100')).toBe(false);
    expect(isSameBrazilianSubscriber('351912345678', '35191234567')).toBe(
      false,
    );
  });

  it('entrada vazia/lixo nunca casa', () => {
    expect(isSameBrazilianSubscriber('', '5592995550101')).toBe(false);
    expect(isSameBrazilianSubscriber('5592995550101', '')).toBe(false);
    expect(isSameBrazilianSubscriber('abc', 'def')).toBe(false);
  });
});
