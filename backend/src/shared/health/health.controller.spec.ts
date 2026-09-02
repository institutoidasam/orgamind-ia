import { describe, it, expect, beforeEach } from 'vitest';
import { mockDeep, type MockProxy } from 'vitest-mock-extended';
import {
  HealthCheckService,
  PrismaHealthIndicator,
} from '@nestjs/terminus';
import { HealthController } from './health.controller';
import { PrismaService } from '../prisma/prisma.service';

describe('HealthController', () => {
  let controller: HealthController;
  let health: MockProxy<HealthCheckService>;
  let prismaIndicator: MockProxy<PrismaHealthIndicator>;
  let prisma: MockProxy<PrismaService>;

  beforeEach(() => {
    health = mockDeep<HealthCheckService>();
    prismaIndicator = mockDeep<PrismaHealthIndicator>();
    prisma = mockDeep<PrismaService>();
    controller = new HealthController(health, prismaIndicator, prisma);
  });

  it('live() invokes HealthCheckService.check with an empty list', async () => {
    health.check.mockResolvedValue({ status: 'ok' } as any);
    const result = await controller.live();
    expect(result).toEqual({ status: 'ok' });
    expect(health.check).toHaveBeenCalledWith([]);
  });

  it('ready() includes a prisma ping check', async () => {
    health.check.mockResolvedValue({ status: 'ok' } as any);
    prismaIndicator.pingCheck.mockResolvedValue({
      database: { status: 'up' },
    } as any);

    const result = await controller.ready();

    expect(result).toEqual({ status: 'ok' });
    expect(health.check).toHaveBeenCalledTimes(1);
    const indicators = health.check.mock.calls[0][0] as Array<() => unknown>;
    expect(indicators).toHaveLength(1);
    // Invoke the indicator to verify it forwards to prisma indicator
    await indicators[0]();
    expect(prismaIndicator.pingCheck).toHaveBeenCalledWith('database', prisma);
  });
});
