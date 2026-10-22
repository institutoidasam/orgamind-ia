import type { ExecutionContext } from '@nestjs/common';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import { RolesGuard } from '../auth/roles.guard';
import { TeamWhatsappController } from './team-whatsapp.controller';
import type { TeamWhatsappService } from './team-whatsapp.service';
import type { TeamWhatsappScheduleService } from './team-whatsapp-schedule.service';
import type { CreateTeamDispatchDto } from './dto/create-team-dispatch.dto';

const HANDLERS = [
  'targets',
  'createDispatch',
  'listDispatches',
  'listScheduled',
  'cancel',
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
  };
  const schedule = {
    listScheduled: vi.fn().mockResolvedValue({ items: [] }),
    cancel: vi.fn().mockResolvedValue({ id: 'd1', state: 'CANCELLED' }),
  };
  const controller = new TeamWhatsappController(
    service as unknown as TeamWhatsappService,
    schedule as unknown as TeamWhatsappScheduleService,
  );
  return { service, schedule, controller };
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

  it('POST de cancelamento responde 200', () => {
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, handlerOf('cancel'))).toBe(
      200,
    );
  });
});

describe('TeamWhatsappController — repasse do ator', () => {
  it('cada handler repassa o id do ator ao service', async () => {
    const { service, controller } = controllerWithService();
    const dto = {
      channelId: 'c1',
      text: 'oi',
      target: { type: 'user', userId: 'u1' },
    } as CreateTeamDispatchDto;
    await controller.targets(req);
    await controller.createDispatch(dto, req);
    await controller.listDispatches(req);
    expect(service.targets).toHaveBeenCalledWith('actor-1');
    expect(service.dispatch).toHaveBeenCalledWith('actor-1', dto);
    expect(service.listDispatches).toHaveBeenCalledWith('actor-1');
  });

  it('agendados e cancelamento repassam o ator (e o id do envio)', async () => {
    const { schedule, controller } = controllerWithService();
    await controller.listScheduled(req);
    await controller.cancel('d1', req);
    expect(schedule.listScheduled).toHaveBeenCalledWith('actor-1');
    expect(schedule.cancel).toHaveBeenCalledWith('actor-1', 'd1');
  });
});
