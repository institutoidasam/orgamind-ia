import type { ExecutionContext } from '@nestjs/common';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import { RolesGuard } from '../auth/roles.guard';
import { TeamWhatsappController } from './team-whatsapp.controller';
import type { TeamWhatsappService } from './team-whatsapp.service';
import type { TeamWhatsappResultsService } from './team-whatsapp-results.service';
import type { TeamWhatsappRetryService } from './team-whatsapp-retry.service';
import type { TeamWhatsappScheduleService } from './team-whatsapp-schedule.service';
import type { DispatchRecipientsQuery } from './dto/dispatch-recipients-query.dto';
import type { CreateTeamDispatchDto } from './dto/create-team-dispatch.dto';
import type { RetryRecipientsInput } from './dto/retry-recipients.dto';

const HANDLERS = [
  'targets',
  'personRoute',
  'createDispatch',
  'listDispatches',
  'dispatchDetail',
  'dispatchRecipients',
  'listScheduled',
  'cancel',
  'retry',
] as const;
type Handler = (typeof HANDLERS)[number];
// Lido como dado (metadados), não chamado: evita o falso positivo de unbound-method.
const handlerOf = (name: Handler): object =>
  (TeamWhatsappController.prototype as unknown as Record<Handler, object>)[
    name
  ];

function context(method: Handler, role: string) {
  return {
    getHandler: () => handlerOf(method),
    getClass: () => TeamWhatsappController,
    switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
  } as unknown as ExecutionContext;
}

function controllerWithService() {
  const service = {
    targets: vi.fn().mockResolvedValue({ channels: [], sectors: [] }),
    dispatch: vi
      .fn()
      .mockResolvedValue({ dispatchId: 'd1', queued: 1, skipped: [] }),
    listDispatches: vi.fn().mockResolvedValue({ items: [] }),
    personRoute: vi
      .fn()
      .mockResolvedValue({ userId: 'u1', sector: null, channel: null }),
  };
  const schedule = {
    listScheduled: vi.fn().mockResolvedValue({ items: [] }),
    cancel: vi.fn().mockResolvedValue({ id: 'd1', state: 'CANCELLED' }),
  };
  const results = {
    detail: vi.fn().mockResolvedValue({ id: 'd1' }),
    recipients: vi.fn().mockResolvedValue({ items: [] }),
  };
  const retry = { retry: vi.fn().mockResolvedValue({ requeued: 1 }) };
  const controller = new TeamWhatsappController(
    service as unknown as TeamWhatsappService,
    schedule as unknown as TeamWhatsappScheduleService,
    results as unknown as TeamWhatsappResultsService,
    retry as unknown as TeamWhatsappRetryService,
  );
  return { service, schedule, results, retry, controller };
}

const req = { user: { sub: 'actor-1' } } as Parameters<
  TeamWhatsappController['targets']
>[0];

describe('TeamWhatsappController — metadados', () => {
  it.each(HANDLERS)('%s exige ADMIN, SUPERVISOR ou OPERATOR', (handler) => {
    expect(Reflect.getMetadata('roles', handlerOf(handler))).toEqual([
      'ADMIN',
      'SUPERVISOR',
      'OPERATOR',
    ]);
  });

  it('o guard real barra VIEWER em todas as rotas', () => {
    const guard = new RolesGuard(new Reflector());
    for (const handler of HANDLERS) {
      expect(() => guard.canActivate(context(handler, 'VIEWER'))).toThrow(
        expect.objectContaining({
          status: 403,
          code: 'auth.insufficient_role',
        }),
      );
      expect(guard.canActivate(context(handler, 'OPERATOR'))).toBe(true);
    }
  });

  it('POST de envio responde 202', () => {
    expect(
      Reflect.getMetadata(HTTP_CODE_METADATA, handlerOf('createDispatch')),
    ).toBe(202);
  });

  it.each(['cancel', 'retry'] as const)('POST de %s responde 200', (name) => {
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, handlerOf(name))).toBe(200);
  });
});

const PAGE = { page: 2, pageSize: 10 };
const DISPATCH_DTO = {
  channelId: 'c1',
  text: 'oi',
  target: { type: 'user', userId: 'u1' },
} as CreateTeamDispatchDto;

describe('TeamWhatsappController — repasse do ator', () => {
  it('cada handler repassa o id do ator ao service', async () => {
    const { service, controller } = controllerWithService();
    await controller.targets(req);
    await controller.createDispatch(DISPATCH_DTO, req);
    await controller.listDispatches(PAGE, req);
    expect(service.targets).toHaveBeenCalledWith('actor-1');
    expect(service.dispatch).toHaveBeenCalledWith('actor-1', DISPATCH_DTO);
    expect(service.listDispatches).toHaveBeenCalledWith('actor-1', PAGE);
  });

  it('person-route repassa o ator e o userId da query', async () => {
    const { service, controller } = controllerWithService();
    await controller.personRoute({ userId: 'u1' }, req);
    expect(service.personRoute).toHaveBeenCalledWith('actor-1', 'u1');
  });

  it('agendados e cancelamento repassam o ator (e o id do envio)', async () => {
    const { schedule, controller } = controllerWithService();
    await controller.listScheduled(PAGE, req);
    await controller.cancel('d1', req);
    expect(schedule.listScheduled).toHaveBeenCalledWith('actor-1', PAGE);
    expect(schedule.cancel).toHaveBeenCalledWith('actor-1', 'd1');
  });

  it('detalhe e destinatários repassam o ator, o id do envio e a query', async () => {
    const { results, controller } = controllerWithService();
    const query: DispatchRecipientsQuery = {
      status: 'FAILED',
      page: 2,
      pageSize: 100,
    };
    await controller.dispatchDetail('d1', req);
    await controller.dispatchRecipients('d1', query, req);
    expect(results.detail).toHaveBeenCalledWith('actor-1', 'd1');
    expect(results.recipients).toHaveBeenCalledWith('actor-1', 'd1', query);
  });

  it('repetir repassa o ator, o id do envio e o corpo', async () => {
    const { retry, controller } = controllerWithService();
    const dto: RetryRecipientsInput = { recipientIds: ['r1', 'r2'] };
    await expect(controller.retry('d1', dto, req)).resolves.toEqual({
      requeued: 1,
    });
    expect(retry.retry).toHaveBeenCalledWith('actor-1', 'd1', dto);
  });
});
