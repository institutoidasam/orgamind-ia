import { describe, it, expect } from 'vitest';
import {
  Get,
  RequestMethod,
  type ExecutionContext,
  type Type,
} from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import type { Role } from '@prisma/client';
import { RolesGuard } from '../auth/roles.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { ROLES_KEY, Roles } from '../auth/decorators/roles.decorator';
import {
  PERMISSION_KEY,
  RequirePermission,
} from '../auth/decorators/require-permission.decorator';
import type { PermissionsService } from './permissions.service';
import {
  defaultPermissionsFor,
  type PermissionKey,
} from '../../shared/authz/permissions';
import { DomainError } from '../../shared/errors/domain.error';
import { SectorPeopleController } from '../sector-people/sector-people.controller';
import { StaffScheduleController } from '../staff-schedule/staff-schedule.controller';
import { TeamWhatsappController } from '../team-whatsapp/team-whatsapp.controller';
import { ShiftsController } from '../shifts/shifts.controller';
import { LevelsController } from '../levels/levels.controller';
import { InternalSectorsController } from '../internal-sectors/internal-sectors.controller';
import { AuditTrailController } from '../audit-trail/audit-trail.controller';

/**
 * GB1 (aceite 10): com a matriz inicial, cada rota dos sete controllers permite
 * e nega os mesmos papéis de antes da troca de `@Roles` por `@RequirePermission`.
 * A tabela abaixo é o "Antes" literal (spec B1, plano "Rotas"): editá-la para
 * acompanhar uma troca é mudar o comportamento, não ajustar o teste.
 */
const ALL: readonly Role[] = ['ADMIN', 'SUPERVISOR', 'OPERATOR', 'VIEWER'];
const ASO: readonly Role[] = ['ADMIN', 'SUPERVISOR', 'OPERATOR'];
const AS: readonly Role[] = ['ADMIN', 'SUPERVISOR'];
const A: readonly Role[] = ['ADMIN'];

type ParityRow = {
  controller: Type<object>;
  routes: [string, readonly Role[]][];
};

const CRUD_A: [string, readonly Role[]][] = [
  ['GET /', A],
  ['POST /', A],
  ['PUT /order', A],
  ['PATCH /:id', A],
];

const PARITY: ParityRow[] = [
  {
    controller: SectorPeopleController,
    routes: [
      ['GET /', ASO],
      ['GET /candidates', ASO],
      ['GET /contact-candidates', ASO],
      ['POST /', ASO],
      ['POST /from-contacts', ASO],
      ['POST /move', ASO],
      ['PATCH /:userId', ASO],
      ['POST /:userId/status', ASO], // exceção: ver `expectedRoles`
      ['DELETE /:userId', ASO],
    ],
  },
  {
    controller: StaffScheduleController,
    routes: [
      ['GET /options', ASO],
      ['GET /board', ASO],
      ['PUT /users/:userId/schedule', ASO],
      ['DELETE /users/:userId/schedule', ASO],
      ['POST /users/:userId/exceptions', ASO],
      ['DELETE /exceptions/:exceptionId', ASO],
    ],
  },
  {
    controller: TeamWhatsappController,
    routes: [
      ['GET /targets', ASO],
      ['GET /roster', ASO],
      ['GET /person-route', ASO],
      ['GET /dispatches', ASO],
      ['GET /dispatches/:id', ASO],
      ['GET /dispatches/:id/recipients', ASO],
      ['GET /scheduled', ASO],
      ['POST /dispatches', ASO],
      ['POST /dispatches/:id/cancel', ASO],
      ['POST /dispatches/:id/retry', ASO],
    ],
  },
  { controller: ShiftsController, routes: CRUD_A },
  { controller: LevelsController, routes: CRUD_A },
  {
    controller: InternalSectorsController,
    routes: [
      ['GET /', ALL],
      ['POST /', A],
      ['GET /:id', A],
      ['PATCH /:id', A],
      ['GET /:id/members', ALL],
    ],
  },
  {
    controller: AuditTrailController,
    routes: [
      ['GET /', A],
      ['GET /people/:userId', AS],
    ],
  },
];

/** Rotas novas do Lote C (não são "função que já existia"): ainda sem linha na tabela de paridade. */
const NEW_ROUTES: readonly string[] = [
  'AuditTrailController GET /people/:userId/assignments',
];

function withoutNew(found: string[], added: readonly string[]): string[] {
  return found.filter((route) => !added.includes(route));
}

/**
 * Única rota cuja expectativa depende do metadado: com `@Roles` o guard deixa o
 * OPERATOR passar (quem o recusa é o serviço, `person-actions.policy.ts`); com
 * `@RequirePermission('pessoas.inativar')` o guard já o recusa.
 */
const STATUS_ROUTE = 'POST /:userId/status';
const STATUS_PERMISSION: PermissionKey = 'pessoas.inativar';

type Handler = { route: string; handler: () => void };

function handlersOf(controller: Type<object>): Handler[] {
  const proto = controller.prototype as Record<string, () => void>;
  return Object.getOwnPropertyNames(proto).flatMap((name) => {
    const handler = proto[name];
    if (name === 'constructor' || typeof handler !== 'function') return [];
    const method = Reflect.getMetadata(METHOD_METADATA, handler) as
      RequestMethod | undefined;
    if (method === undefined) return [];
    const path = Reflect.getMetadata(PATH_METADATA, handler) as string;
    return [
      {
        route: `${RequestMethod[method]} /${path.replace(/^\//, '')}`,
        handler,
      },
    ];
  });
}

function routeContext(
  controller: Type<object>,
  handler: () => void,
  role: Role,
): ExecutionContext {
  return {
    getClass: () => controller,
    getHandler: () => handler,
    switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
  } as unknown as ExecutionContext;
}

const effective = {
  effectiveFor: (role: Role) => Promise.resolve(defaultPermissionsFor(role)),
} as unknown as PermissionsService;
const reflector = new Reflector();
const rolesGuard = new RolesGuard(reflector);
const permissionsGuard = new PermissionsGuard(reflector, effective);

/** Permitido = o `RolesGuard` e depois o `PermissionsGuard` deixam passar. */
async function isAllowed(ctx: ExecutionContext): Promise<boolean> {
  try {
    return (
      rolesGuard.canActivate(ctx) && (await permissionsGuard.canActivate(ctx))
    );
  } catch (error) {
    if (error instanceof DomainError && error.status === 403) return false;
    throw error;
  }
}

function expectedRoles(
  route: string,
  listed: readonly Role[],
  handler: () => void,
): readonly Role[] {
  const key = Reflect.getMetadata(PERMISSION_KEY, handler) as
    PermissionKey | undefined;
  if (route !== STATUS_ROUTE || key === undefined) return listed;
  if (key !== STATUS_PERMISSION) throw new Error(`${route} usa a chave ${key}`);
  return AS;
}

/** Rotas que misturam `@Roles` e `@RequirePermission`, no mesmo nível ou entre classe e handler. */
function mixedRoutes(controller: Type<object>): string[] {
  const has = (key: string, target: object) =>
    Reflect.getMetadata(key, target) !== undefined;
  const onClass = (key: string) => has(key, controller);
  return handlersOf(controller)
    .filter(({ handler }) => {
      const roles = onClass(ROLES_KEY) || has(ROLES_KEY, handler);
      const permission =
        onClass(PERMISSION_KEY) || has(PERMISSION_KEY, handler);
      return roles && permission;
    })
    .map(({ route }) => `${controller.name} ${route}`);
}

describe('equivalência das rotas com a matriz inicial (GB1)', () => {
  it.each(PARITY)(
    '$controller.name: cada papel é permitido e negado como antes',
    async ({ controller, routes }) => {
      const handlers = new Map(
        handlersOf(controller).map((h) => [h.route, h.handler]),
      );
      const divergences: string[] = [];

      for (const [route, listed] of routes) {
        const handler = handlers.get(route);
        if (!handler) {
          divergences.push(`${route}: rota ausente no controller`);
          continue;
        }
        const expected = expectedRoles(route, listed, handler);
        for (const role of ALL) {
          const allowed = await isAllowed(
            routeContext(controller, handler, role),
          );
          if (allowed !== expected.includes(role)) {
            divergences.push(`${route} ${role}: permitido=${allowed}`);
          }
        }
      }

      expect(divergences).toEqual([]);
    },
  );

  it('toda rota dos sete controllers está na tabela, e a tabela não tem rota que sumiu', () => {
    const declared = PARITY.flatMap(({ controller, routes }) =>
      routes.map(([route]) => `${controller.name} ${route}`),
    );
    const found = PARITY.flatMap(({ controller }) =>
      handlersOf(controller).map(({ route }) => `${controller.name} ${route}`),
    );

    expect(withoutNew(found, NEW_ROUTES).sort()).toEqual(declared.sort());
  });

  it('nenhuma rota mistura @Roles e @RequirePermission', () => {
    expect(PARITY.flatMap(({ controller }) => mixedRoutes(controller))).toEqual(
      [],
    );
  });
});

describe('detector de mistura de @Roles e @RequirePermission', () => {
  @Roles('ADMIN')
  class RolesClassPermissionHandler {
    @Get() @RequirePermission('pessoas.editar') a() {}
  }
  @RequirePermission('pessoas.editar')
  class PermissionClassRolesHandler {
    @Get() @Roles('ADMIN') a() {}
  }

  it('acusa permissão no handler com @Roles na classe, e o contrário', () => {
    expect(mixedRoutes(RolesClassPermissionHandler)).toHaveLength(1);
    expect(mixedRoutes(PermissionClassRolesHandler)).toHaveLength(1);
  });
});
