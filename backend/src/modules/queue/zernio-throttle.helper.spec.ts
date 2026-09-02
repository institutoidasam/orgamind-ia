import { describe, it, expect, vi } from 'vitest';
import type Redis from 'ioredis';
import {
  acquireZernioSendSlot,
  waitForZernioSlot,
  zernioThrottleKey,
  ZERNIO_SEND_MIN_INTERVAL_MS,
} from './zernio-throttle.helper';

/**
 * Redis de mentira com a semântica REAL de `SET key val PX ms NX`: só o
 * primeiro SET dentro da janela vence; os demais recebem null. É o que dá
 * sentido ao teste "N jobs no mesmo canal não excedem a taxa".
 */
function fakeRedis(now = () => Date.now()) {
  const store = new Map<string, number>(); // key → expiraEm (epoch ms)
  return {
    set: vi.fn((key: string, _v: string, _px: string, ms: number) => {
      const expiry = store.get(key);
      // NX: a chave ainda vale → o SET não acontece.
      if (expiry !== undefined && expiry > now()) return Promise.resolve(null);
      store.set(key, now() + ms);
      return Promise.resolve('OK');
    }),
    pttl: vi.fn((key: string) => {
      const expiry = store.get(key);
      if (expiry === undefined) return Promise.resolve(-2);
      const left = expiry - now();
      return Promise.resolve(left > 0 ? left : -2);
    }),
  } as unknown as Redis;
}

describe('acquireZernioSendSlot (ZA4 — ≤ 1 msg/s por canal ZERNIO)', () => {
  it('o primeiro envio do canal na janela adquire o slot', async () => {
    const redis = fakeRedis();

    await expect(acquireZernioSendSlot(redis, 'chan-zr')).resolves.toEqual({
      acquired: true,
    });
  });

  it('o segundo envio na MESMA janela é recusado, com o tempo que falta para a próxima', async () => {
    let clock = 1_000_000;
    const redis = fakeRedis(() => clock);
    await acquireZernioSendSlot(redis, 'chan-zr');
    clock += 300; // 300ms depois, ainda dentro do 1s

    const result = await acquireZernioSendSlot(redis, 'chan-zr');

    expect(result.acquired).toBe(false);
    if (result.acquired) throw new Error('inalcançável');
    // Espera o que falta da janela (700ms) + um jitter pequeno (anti-manada).
    expect(result.retryDelayMs).toBeGreaterThanOrEqual(700);
    expect(result.retryDelayMs).toBeLessThan(700 + 500);
  });

  it('N jobs disparados juntos no mesmo canal: só 1 passa por janela de 1s', async () => {
    let clock = 1_000_000;
    const redis = fakeRedis(() => clock);

    const janela1 = await Promise.all(
      Array.from({ length: 10 }, () => acquireZernioSendSlot(redis, 'chan-zr')),
    );
    expect(janela1.filter((r) => r.acquired)).toHaveLength(1);

    // Passou 1 segundo → exatamente mais um passa.
    clock += ZERNIO_SEND_MIN_INTERVAL_MS;
    const janela2 = await Promise.all(
      Array.from({ length: 10 }, () => acquireZernioSendSlot(redis, 'chan-zr')),
    );
    expect(janela2.filter((r) => r.acquired)).toHaveLength(1);
  });

  it('canais diferentes têm baldes independentes (o teto é POR CANAL)', async () => {
    const redis = fakeRedis();

    const a = await acquireZernioSendSlot(redis, 'chan-a');
    const b = await acquireZernioSendSlot(redis, 'chan-b');

    expect(a.acquired).toBe(true);
    expect(b.acquired).toBe(true);
    expect(zernioThrottleKey('chan-a')).not.toBe(zernioThrottleKey('chan-b'));
  });

  // Fail-open deliberado: estourar o balde do Zernio devolve 429, que o mapper
  // já classifica como RETENTÁVEL. Travar TODO o envio porque o Redis piscou
  // seria um estrago maior do que o 429.
  it('Redis fora → libera o envio (fail-open), não trava a fila', async () => {
    const redis = {
      set: vi.fn().mockRejectedValue(new Error('redis down')),
      pttl: vi.fn(),
    } as unknown as Redis;

    await expect(acquireZernioSendSlot(redis, 'chan-zr')).resolves.toEqual({
      acquired: true,
    });
  });
});

/**
 * A LEITURA (sync do inbox) não pode "adiar o job e sair", como faz o envio: ela
 * está no meio de um laço de ~100 conversas. Ela ESPERA o slot. O que não muda é
 * o BALDE: é a mesma chave Redis do envio — se fosse um balde paralelo, os dois
 * somados furariam os 60 req/min do Zernio exatamente como antes.
 */
describe('waitForZernioSlot (leitura: espera o slot em vez de adiar)', () => {
  it('balde livre → passa na hora, sem dormir', async () => {
    const redis = fakeRedis();
    const sleep = vi.fn().mockResolvedValue(undefined);

    await waitForZernioSlot(redis, 'chan-zr', { sleep });

    expect(sleep).not.toHaveBeenCalled();
  });

  it('balde ocupado → dorme o que falta da janela e só então passa', async () => {
    let clock = 1_000_000;
    const redis = fakeRedis(() => clock);
    // Alguém (o ENVIO) acabou de gastar o slot do canal.
    await acquireZernioSendSlot(redis, 'chan-zr');
    clock += 300;
    const sleep = vi.fn(async (ms: number) => {
      clock += ms; // o relógio virtual só anda quando se dorme
    });

    await waitForZernioSlot(redis, 'chan-zr', { sleep });

    expect(sleep).toHaveBeenCalledTimes(1);
    // Esperou os ~700ms que faltavam (+ jitter), não um valor arbitrário.
    expect(sleep.mock.calls[0][0]).toBeGreaterThanOrEqual(700);
  });

  /**
   * O teste que prova a instrução "REUSE o mesmo balde": um slot tomado pelo
   * SYNC tem de recusar o ENVIO no mesmo canal. Se cada um tivesse a sua chave,
   * os dois passariam — e o Zernio veria 2 req/s.
   */
  it('é o MESMO balde do envio: slot tomado pelo sync recusa o envio no canal', async () => {
    let clock = 1_000_000;
    const redis = fakeRedis(() => clock);

    await waitForZernioSlot(redis, 'chan-zr', { sleep: async () => {} });
    const envio = await acquireZernioSendSlot(redis, 'chan-zr');

    expect(envio.acquired).toBe(false);
  });

  it('Redis fora → fail-open (o sync não trava porque o Redis piscou)', async () => {
    const redis = {
      set: vi.fn().mockRejectedValue(new Error('redis down')),
      pttl: vi.fn(),
    } as unknown as Redis;
    const sleep = vi.fn().mockResolvedValue(undefined);

    await waitForZernioSlot(redis, 'chan-zr', { sleep });

    expect(sleep).not.toHaveBeenCalled();
  });
});
