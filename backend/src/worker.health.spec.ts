import { describe, it, expect, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type Redis from 'ioredis';
import {
  checkReadiness,
  createHealthHandler,
  scheduleContactSyncCron,
} from './worker';

function makeRes() {
  const res = {
    statusCode: 0,
    headers: {} as Record<string, unknown>,
    body: '',
    writeHead: vi.fn(function (this: any, code: number, headers?: any) {
      res.statusCode = code;
      if (headers) res.headers = headers;
      return this;
    }),
    end: vi.fn(function (this: any, chunk?: string) {
      if (chunk) res.body = chunk;
      return this;
    }),
  };
  return res as unknown as ServerResponse & {
    statusCode: number;
    body: string;
  };
}

describe('worker readiness', () => {
  describe('checkReadiness', () => {
    it('returns ready when Redis PING succeeds', async () => {
      const redis = { ping: vi.fn().mockResolvedValue('PONG') } as unknown as Redis;
      const result = await checkReadiness(redis);
      expect(result.ready).toBe(true);
      expect(result.redis).toBe('up');
      expect(redis.ping).toHaveBeenCalledTimes(1);
    });

    it('returns NOT ready when Redis PING rejects', async () => {
      const redis = {
        ping: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
      } as unknown as Redis;
      const result = await checkReadiness(redis);
      expect(result.ready).toBe(false);
      expect(result.redis).toBe('down');
    });

    it('returns NOT ready when Redis client is missing', async () => {
      const result = await checkReadiness(undefined);
      expect(result.ready).toBe(false);
      expect(result.redis).toBe('down');
    });
  });

  describe('createHealthHandler', () => {
    it('responds 200 to /health/live unconditionally', async () => {
      const redis = {
        ping: vi.fn().mockRejectedValue(new Error('down')),
      } as unknown as Redis;
      const handler = createHealthHandler(redis);
      const res = makeRes();
      await handler({ url: '/health/live' } as IncomingMessage, res);
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).status).toBe('ok');
    });

    it('responds 200 to /health/ready when Redis is up', async () => {
      const redis = { ping: vi.fn().mockResolvedValue('PONG') } as unknown as Redis;
      const handler = createHealthHandler(redis);
      const res = makeRes();
      await handler({ url: '/health/ready' } as IncomingMessage, res);
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).status).toBe('ok');
    });

    it('responds 503 to /health/ready when Redis is down', async () => {
      const redis = {
        ping: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
      } as unknown as Redis;
      const handler = createHealthHandler(redis);
      const res = makeRes();
      await handler({ url: '/health/ready' } as IncomingMessage, res);
      expect(res.statusCode).toBe(503);
      const body = JSON.parse(res.body);
      expect(body.status).toBe('unavailable');
      expect(body.redis).toBe('down');
    });

    it('responds 404 to unknown paths', async () => {
      const redis = { ping: vi.fn().mockResolvedValue('PONG') } as unknown as Redis;
      const handler = createHealthHandler(redis);
      const res = makeRes();
      await handler({ url: '/nope' } as IncomingMessage, res);
      expect(res.statusCode).toBe(404);
    });
  });
});

/**
 * Fix round 2 (revisão pós-commit, item #2 remanescente) — o BullMQ chaveia
 * repetíveis por `md5(name:jobId:endDate:tz:pattern)`: trocar só o
 * `pattern` no `add()` de bootstrap() CRIA um segundo repetível em vez de
 * substituir o antigo (das 06:00 UTC, fora da janela padrão) — cada job
 * processado do ZSET se re-arma sozinho, então o antigo nunca parava
 * sozinho. `scheduleContactSyncCron` foi extraída de `bootstrap()`
 * exatamente para este teste existir sem precisar abrir conexões reais com
 * Postgres/Redis.
 */
describe('scheduleContactSyncCron', () => {
  it('remove o repetível antigo (06:00 UTC) ANTES de agendar o novo (13:00 UTC), mesmos name/jobId', async () => {
    const calls: string[] = [];
    const queue = {
      removeRepeatable: vi.fn(() => {
        calls.push('removeRepeatable');
        return Promise.resolve(true);
      }),
      add: vi.fn(() => {
        calls.push('add');
        return Promise.resolve({ id: 'job1' } as never);
      }),
    };

    await scheduleContactSyncCron(queue as never, true);

    expect(queue.removeRepeatable).toHaveBeenCalledWith(
      'cron',
      { pattern: '0 6 * * *' },
      'contact-sync-cron-daily',
    );
    expect(queue.add).toHaveBeenCalledWith(
      'cron',
      {},
      expect.objectContaining({
        repeat: { pattern: '0 13 * * *' },
        jobId: 'contact-sync-cron-daily',
      }),
    );
    // A ordem importa: remover DEPOIS de agendar deixaria uma janela (por
    // menor que fosse) com os dois repetíveis coexistindo por acidente.
    expect(calls).toEqual(['removeRepeatable', 'add']);
  });

  it('não lança quando o repetível antigo já não existe (idempotente)', async () => {
    const queue = {
      removeRepeatable: vi.fn().mockResolvedValue(false),
      add: vi.fn().mockResolvedValue({ id: 'job1' }),
    };

    await expect(scheduleContactSyncCron(queue as never, true)).resolves.toBe(
      'scheduled',
    );
  });

  /**
   * ★ CRÍTICO (revisão final da Fase B) — o cron virou uma VARREDURA EM
   * MASSA não vigiada. Antes da Fase B, `contact-sync.processor.ts` voltava
   * cedo quando não havia canal EVOLUTION, e em produção (só GoZap) o cron
   * diário era um no-op silencioso. Com `resolveSyncChannel` resolvendo o
   * canal GoZap padrão, o mesmo cron passou a enfileirar a BASE INTEIRA
   * (~5000 `/chat/check` por noite) sem ninguém clicar em nada — e consulta
   * de existência em massa por cliente NÃO OFICIAL é sinal conhecido de
   * bloqueio (este cliente já perdeu um número). A validação ativa é
   * EXPLÍCITA por decisão de produto (spec B.5): o operador clica depois de
   * ler o aviso de risco. Logo o cron é OPT-IN.
   */
  describe('CONTACT_SYNC_CRON_ENABLED', () => {
    it('desligado: NÃO agenda nada e ainda assim remove os repetíveis já gravados (06:00 e 13:00 UTC)', async () => {
      const queue = {
        removeRepeatable: vi.fn().mockResolvedValue(true),
        add: vi.fn().mockResolvedValue({ id: 'job1' }),
      };

      await expect(
        scheduleContactSyncCron(queue as never, false),
      ).resolves.toBe('disabled');

      // Um deploy que já rodou com o cron ligado tem a chave gravada no ZSET
      // do BullMQ, e cada job processado se RE-ARMA sozinho: parar de chamar
      // `add()` não desliga nada. Só `removeRepeatable` com a MESMA tripla
      // (name, pattern, jobId) apaga a chave — e o `pattern` faz parte do
      // hash, então as DUAS gerações precisam ser removidas.
      expect(queue.removeRepeatable).toHaveBeenCalledWith(
        'cron',
        { pattern: '0 6 * * *' },
        'contact-sync-cron-daily',
      );
      expect(queue.removeRepeatable).toHaveBeenCalledWith(
        'cron',
        { pattern: '0 13 * * *' },
        'contact-sync-cron-daily',
      );
      expect(queue.add).not.toHaveBeenCalled();
    });

    it('desligado é o PADRÃO: sem o flag, nada é agendado', async () => {
      const queue = {
        removeRepeatable: vi.fn().mockResolvedValue(true),
        add: vi.fn().mockResolvedValue({ id: 'job1' }),
      };

      await expect(scheduleContactSyncCron(queue as never)).resolves.toBe(
        'disabled',
      );
      expect(queue.add).not.toHaveBeenCalled();
    });
  });
});
