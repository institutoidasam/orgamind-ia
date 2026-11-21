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
import { TeamAlertController } from '../team-whatsapp/team-alert.controller';
import { TeamPanoramaController } from '../team-whatsapp/team-panorama.controller';
import { TeamPendencyController } from '../team-whatsapp/team-pendency.controller';
import { TeamPendencyHandoverController } from '../team-whatsapp/team-pendency-handover.controller';
import { TeamConversationDispatchController } from '../team-whatsapp/team-conversation-dispatch.controller';
import { ShiftsController } from '../shifts/shifts.controller';
import { LevelsController } from '../levels/levels.controller';
import { InternalSectorsController } from '../internal-sectors/internal-sectors.controller';
import { AuditTrailController } from '../audit-trail/audit-trail.controller';
import { PeopleExportController } from '../people-export/people-export.controller';
import { PeopleImportController } from '../people-import/people-import.controller';

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
  {
    // Lote I (DI13): rotas novas, mesmos papéis do envio; leitura com `@Roles`,
    // escrita só com `@RequirePermission('equipe.enviar')` (a chave da urgência
    // é do serviço). A mistura é barrada pelo teste abaixo.
    controller: TeamAlertController,
    routes: [
      ['GET /dispatches/:id/alert', ASO],
      ['POST /dispatches/:id/recipients/:recipientId/ack', ASO],
      ['DELETE /dispatches/:id/recipients/:recipientId/ack', ASO],
      ['POST /dispatches/:id/reminders', ASO],
    ],
  },
  { controller: TeamPanoramaController, routes: [['GET /panorama', ASO]] },
  {
    controller: TeamPendencyController,
    routes: [
      ['GET /pendencies', ASO],
      ['GET /pendency-count', ASO],
      ['GET /pendencies/:id', ASO],
      ['GET /pendencies/:id/handlers', ASO],
      ['POST /pendencies/:id/assume', ASO],
      ['POST /pendencies/:id/transfer', ASO],
      ['POST /pendencies/:id/notes', ASO],
      ['POST /pendencies/:id/close', ASO],
      ['POST /pendencies/:id/reopen', ASO],
    ],
  },
  {
    // Lote K3 (DT4): leitura e passagem só com `@RequirePermission('equipe.enviar')`.
    controller: TeamPendencyHandoverController,
    routes: [
      ['GET /pendency-handover/targets', ASO],
      ['POST /pendency-handover', ASO],
    ],
  },
  {
    // Lote K3 (DT7): último envio da conversa, da caixa (`@Roles('ADMIN', 'OPERATOR')`).
    controller: TeamConversationDispatchController,
    routes: [
      [
        'GET /conversations/:conversationId/last-dispatch',
        ['ADMIN', 'OPERATOR'],
      ],
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

/** Rotas novas dos Lotes C e F (não são "função que já existia"): ainda sem linha na tabela de paridade. */
const NEW_ROUTES: readonly string[] = [
  'AuditTrailController GET /people/:userId/assignments',
  'TeamWhatsappController POST /dispatches/preview', // Lote F (C4): portão do envio
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

/** Controllers com a chave na classe (Etapa 2); o Lote E acrescenta o dele. */
const CLASS_KEY_CONTROLLERS: {
  controller: Type<object>;
  key: PermissionKey;
}[] = [
  { controller: PeopleExportController, key: 'pessoas.exportar' },
  { controller: PeopleImportController, key: 'pessoas.importar' },
];

/** Rotas cuja chave resolvida (handler vale sobre a classe) não é a esperada, ou que declaram `@Roles`. */
function routesOffClassKey(
  controller: Type<object>,
  key: PermissionKey,
): string[] {
  return handlersOf(controller)
    .filter(({ handler }) => {
      const targets = [handler, controller];
      const resolved = reflector.getAllAndOverride<PermissionKey | undefined>(
        PERMISSION_KEY,
        targets,
      );
      return (
        resolved !== key ||
        reflector.getAllAndOverride<unknown>(ROLES_KEY, targets) !== undefined
      );
    })
    .map(({ route }) => `${controller.name} ${route}`);
}

/** `allow` ou o status do 403, por `rota papel`, com a matriz que o `guard` lê. */
async function verdicts(
  controller: Type<object>,
  guard: PermissionsGuard,
): Promise<Record<string, 'allow' | number>> {
  const found: Record<string, 'allow' | number> = {};
  for (const { route, handler } of handlersOf(controller)) {
    for (const role of ALL) {
      const ctx = routeContext(controller, handler, role);
      try {
        rolesGuard.canActivate(ctx);
        await guard.canActivate(ctx);
        found[`${route} ${role}`] = 'allow';
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
        found[`${route} ${role}`] = error.status;
      }
    }
  }
  return found;
}

function expectedVerdicts(
  controller: Type<object>,
  allowed: readonly Role[],
): Record<string, 'allow' | number> {
  return Object.fromEntries(
    handlersOf(controller).flatMap(({ route }) =>
      ALL.map((role) => [
        `${route} ${role}`,
        allowed.includes(role) ? 'allow' : 403,
      ]),
    ),
  );
}

/** Controladores de controle: a chave na classe, mas um handler com `@Roles` e outro com outra chave. */
@RequirePermission('pessoas.exportar')
class Faulty {
  @Get('ok') ok() {}
  @Get('roles') @Roles('ADMIN') withRoles() {}
  @Get('other') @RequirePermission('pessoas.editar') other() {}
}
class NoKey {
  @Get('a') a() {}
}

describe('controllers com a chave na classe (Etapa 2)', () => {
  it('toda rota exige a chave e nenhuma declara @Roles', () => {
    for (const { controller, key } of CLASS_KEY_CONTROLLERS) {
      expect(handlersOf(controller).length).toBeGreaterThan(0);
      expect(routesOffClassKey(controller, key)).toEqual([]);
      expect(mixedRoutes(controller)).toEqual([]);
    }
  });

  it('acusa rota sem a chave, com outra chave ou com @Roles', () => {
    expect(routesOffClassKey(Faulty, 'pessoas.exportar')).toEqual([
      'Faulty GET /roles',
      'Faulty GET /other',
    ]);
    expect(routesOffClassKey(NoKey, 'pessoas.exportar')).toEqual([
      'NoKey GET /a',
    ]);
  });

  it('com a matriz padrão só o ADMIN passa; os outros recebem 403', async () => {
    for (const { controller } of CLASS_KEY_CONTROLLERS) {
      expect(await verdicts(controller, permissionsGuard)).toEqual(
        expectedVerdicts(controller, ['ADMIN']),
      );
    }
  });

  it('com a chave liberada SUPERVISOR e OPERATOR passam; VIEWER continua recusado', async () => {
    for (const { controller, key } of CLASS_KEY_CONTROLLERS) {
      const granted = new PermissionsGuard(reflector, {
        effectiveFor: (role: Role) =>
          Promise.resolve(
            role === 'VIEWER' ? [] : [...defaultPermissionsFor(role), key],
          ),
      } as unknown as PermissionsService);

      expect(await verdicts(controller, granted)).toEqual(
        expectedVerdicts(controller, ASO),
      );
    }
  });
});
