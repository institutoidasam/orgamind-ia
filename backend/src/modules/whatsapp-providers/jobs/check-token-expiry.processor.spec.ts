import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import axios from 'axios';
import { ConfigService } from '@nestjs/config';
import { CheckTokenExpiryProcessor } from './check-token-expiry.processor';

/**
 * The processor pings Meta's debug_token endpoint and emits one of three
 * outcomes via the Nest Logger: long-lived, expiring soon (error level) or
 * still-valid (log level). Tests stub the Logger and axios, then assert which
 * level fired and with what payload.
 *
 * NOTE: We extend WorkerHost from BullMQ which means `super()` runs at
 * construction. In tests we don't want a real worker — the constructor is
 * acceptable to call but we never `await this.process()` against a real Job.
 */
describe('CheckTokenExpiryProcessor', () => {
  let proc: CheckTokenExpiryProcessor;
  let getMock: ReturnType<typeof vi.spyOn>;

  function build(token: string | undefined): CheckTokenExpiryProcessor {
    const config = {
      get: (k: string) => (k === 'META_ACCESS_TOKEN' ? token : undefined),
    } as unknown as ConfigService;
    const p = new CheckTokenExpiryProcessor(config);
    return p;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-07T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    if (getMock) getMock.mockRestore();
  });

  it('warns and skips when META_ACCESS_TOKEN is missing', async () => {
    proc = build(undefined);
    const warn = vi.spyOn(
      (proc as unknown as { logger: { warn: () => void } }).logger,
      'warn',
    );
    const axiosSpy = vi.spyOn(axios, 'get');
    await proc.process();
    expect(warn).toHaveBeenCalledWith(
      'META_ACCESS_TOKEN not configured — skipping check',
    );
    expect(axiosSpy).not.toHaveBeenCalled();
  });

  it('logs "long-lived" when expires_at is 0', async () => {
    proc = build('TOKEN');
    const log = vi.spyOn(
      (proc as unknown as { logger: { log: () => void } }).logger,
      'log',
    );
    getMock = vi
      .spyOn(axios, 'get')
      .mockResolvedValueOnce({ data: { data: { expires_at: 0 } } } as never);
    await proc.process();
    expect(log).toHaveBeenCalledWith('Meta token: long-lived (no expiry)');
  });

  it('logs "long-lived" when expires_at is missing entirely', async () => {
    proc = build('TOKEN');
    const log = vi.spyOn(
      (proc as unknown as { logger: { log: () => void } }).logger,
      'log',
    );
    getMock = vi.spyOn(axios, 'get').mockResolvedValueOnce({ data: {} } as never);
    await proc.process();
    expect(log).toHaveBeenCalledWith('Meta token: long-lived (no expiry)');
  });

  it('emits error-level log when token expires within 7 days', async () => {
    proc = build('TOKEN');
    const error = vi.spyOn(
      (proc as unknown as { logger: { error: () => void } }).logger,
      'error',
    );
    // 3 days from "now"
    const nowSec = Math.floor(Date.now() / 1000);
    const expiresAt = nowSec + 3 * 86400;
    getMock = vi
      .spyOn(axios, 'get')
      .mockResolvedValueOnce({ data: { data: { expires_at: expiresAt } } } as never);
    await proc.process();
    expect(error).toHaveBeenCalledTimes(1);
    const [payload, msg] = error.mock.calls[0] as [
      { daysUntilExpiry: number; expiresAt: string },
      string,
    ];
    expect(payload.daysUntilExpiry).toBe(3);
    expect(msg).toBe('Meta token expires soon');
  });

  it('emits info-level log when token is valid > 7 days', async () => {
    proc = build('TOKEN');
    const log = vi.spyOn(
      (proc as unknown as { logger: { log: () => void } }).logger,
      'log',
    );
    const nowSec = Math.floor(Date.now() / 1000);
    const expiresAt = nowSec + 30 * 86400;
    getMock = vi
      .spyOn(axios, 'get')
      .mockResolvedValueOnce({ data: { data: { expires_at: expiresAt } } } as never);
    await proc.process();
    expect(log).toHaveBeenCalledWith('Meta token valid for 30 more days');
  });

  it('emits error-level log when axios call fails (response data path)', async () => {
    proc = build('TOKEN');
    const error = vi.spyOn(
      (proc as unknown as { logger: { error: () => void } }).logger,
      'error',
    );
    getMock = vi
      .spyOn(axios, 'get')
      .mockRejectedValueOnce({ response: { data: { error: 'oauth' } } });
    await proc.process();
    const [payload, msg] = error.mock.calls[0] as [{ err: unknown }, string];
    expect(payload.err).toEqual({ error: 'oauth' });
    expect(msg).toBe('Meta token check failed');
  });

  it('emits error-level log when axios rejects with bare error message', async () => {
    proc = build('TOKEN');
    const error = vi.spyOn(
      (proc as unknown as { logger: { error: () => void } }).logger,
      'error',
    );
    getMock = vi.spyOn(axios, 'get').mockRejectedValueOnce({ message: 'ETIMEDOUT' });
    await proc.process();
    const [payload, msg] = error.mock.calls[0] as [{ err: unknown }, string];
    expect(payload.err).toBe('ETIMEDOUT');
    expect(msg).toBe('Meta token check failed');
  });

  it('passes the token in both input_token and access_token params', async () => {
    proc = build('SECRET');
    getMock = vi
      .spyOn(axios, 'get')
      .mockResolvedValueOnce({ data: { data: { expires_at: 0 } } } as never);
    await proc.process();
    const [, opts] = getMock.mock.calls[0] as [
      string,
      { params: { input_token: string; access_token: string } },
    ];
    expect(opts.params.input_token).toBe('SECRET');
    expect(opts.params.access_token).toBe('SECRET');
  });
});
