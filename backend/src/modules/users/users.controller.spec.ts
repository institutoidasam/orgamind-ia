import { describe, it, expect, vi, type Mock } from 'vitest';
import {
  BadRequestException,
  HttpStatus,
  type ArgumentMetadata,
  type ExecutionContext,
  type PipeTransform,
} from '@nestjs/common';
import {
  HTTP_CODE_METADATA,
  ROUTE_ARGS_METADATA,
} from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from '../auth/roles.guard';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

// Senhas temporárias falsas, fora de literais em campos "password" (sonarjs).
const TEMP = {
  invite: 'TmpPwd12345x',
  reset: 'NewTmp12345x',
  grant: 'Gr4nt12345xy',
};

const makeService = (
  overrides: Partial<InstanceType<typeof UsersService>> = {},
) =>
  ({
    listUsers: vi.fn().mockResolvedValue({ data: [], total: 0 }),
    createUser: vi
      .fn()
      .mockResolvedValue({ user: {}, temporaryPassword: TEMP.invite }),
    updateUser: vi.fn().mockResolvedValue(undefined),
    deleteUser: vi.fn().mockResolvedValue(undefined),
    resetPassword: vi.fn().mockResolvedValue({ temporaryPassword: TEMP.reset }),
    ...overrides,
  }) as unknown as UsersService;

const adminReq = { user: { sub: 'admin1', role: 'ADMIN' } } as never;
// Handler da rota só para metadados/guard, sem desligar o método do protótipo.
const route = (name: keyof UsersController): object =>
  Object.getOwnPropertyDescriptor(UsersController.prototype, name)
    ?.value as object;

describe('UsersController', () => {
  it('GET /users delegates to service.listUsers with the hasAccess filter', async () => {
    const listUsers = vi.fn().mockResolvedValue({ data: [], total: 0 });
    const ctrl = new UsersController(makeService({ listUsers }));
    await ctrl.listUsers({ page: 1, pageSize: 20 });
    await ctrl.listUsers({ page: 2, pageSize: 100, hasAccess: true });
    expect(listUsers.mock.calls).toEqual([
      [1, 20, { hasAccess: undefined }],
      [2, 100, { hasAccess: true }],
    ]);
  });

  it('POST /users returns user + temporaryPassword', async () => {
    const svc = makeService();
    const ctrl = new UsersController(svc);
    const body = {
      email: 'new@x.com',
      role: 'OPERATOR',
      phone: '92991234567',
      sectorId: undefined,
    } as const;
    const result = await ctrl.createUser(body, adminReq);
    expect(result).toHaveProperty('temporaryPassword');
    const { createUser } = svc as unknown as { createUser: Mock };
    expect(createUser).toHaveBeenCalledWith(body, 'admin1');
  });

  it('PATCH /users/:id delegates actorId from JWT', async () => {
    const updateUser = vi.fn().mockResolvedValue(undefined);
    const ctrl = new UsersController(makeService({ updateUser }));
    await ctrl.updateUser('u2', { name: 'New' }, adminReq);
    expect(updateUser).toHaveBeenCalledWith('u2', { name: 'New' }, 'admin1');
  });
});

describe('UsersController — status e reset', () => {
  it('PATCH /users/:id is declared 204 No Content (empty-body contract — frontend must not .json() it)', () => {
    // @HttpCode is reflected metadata, not observable from a direct method call,
    // so assert the metadata directly. Removing the decorator regresses the
    // "Unexpected end of JSON input" bug, so this guards the backend half.
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, route('updateUser'))).toBe(
      HttpStatus.NO_CONTENT,
    );
  });

  it('POST /users/:id/reset-password returns temporaryPassword', async () => {
    const ctrl = new UsersController(makeService());
    const res = await ctrl.resetPassword('u2', adminReq);
    expect(res.temporaryPassword).toBe(TEMP.reset);
  });

  it('DELETE /users/:id delegates to service.deleteUser', async () => {
    const deleteUser = vi.fn().mockResolvedValue(undefined);
    const ctrl = new UsersController(makeService({ deleteUser }));
    await ctrl.deleteUser('u2', adminReq);
    expect(deleteUser).toHaveBeenCalledWith('u2', 'admin1');
  });
});

describe('UsersController — pessoa sem acesso e dar acesso', () => {
  it('POST /users hasAccess false cria a pessoa e devolve temporaryPassword null', async () => {
    const createPersonWithoutAccess = vi.fn().mockResolvedValue({ id: 'p1' });
    const createUser = vi.fn();
    const svc = makeService({ createPersonWithoutAccess, createUser });
    const body = {
      hasAccess: false,
      name: 'Maria',
      phone: '92991234567',
      sectorId: null,
    } as const;
    await expect(
      new UsersController(svc).createUser(body, adminReq),
    ).resolves.toEqual({
      user: { id: 'p1' },
      temporaryPassword: null,
    });
    expect(createPersonWithoutAccess).toHaveBeenCalledWith('admin1', body);
    expect(createUser).not.toHaveBeenCalled();
  });

  it('POST /users valida o corpo com createUserSchema no parâmetro (sem acesso com e-mail → 400)', () => {
    // O corpo é uma união (sem classe DTO): só o pipe do parâmetro a valida.
    const args = Reflect.getMetadata(
      ROUTE_ARGS_METADATA,
      UsersController,
      'createUser',
    ) as Record<
      string,
      { index: number; pipes: PipeTransform<unknown, unknown>[] }
    >;
    const [pipe] =
      Object.values(args).find((arg) => arg.index === 0)?.pipes ?? [];
    const meta = { type: 'body' } as ArgumentMetadata;
    const person = { hasAccess: false, name: 'Maria', phone: '92991234567' };
    expect(pipe?.transform(person, meta)).toMatchObject({ sectorId: null });
    expect(() =>
      pipe?.transform({ ...person, email: 'maria@x.com' }, meta),
    ).toThrow(BadRequestException);
  });
});

describe('UsersController — pessoa sem acesso e dar acesso', () => {
  it('POST /users/:id/access delega (actorId, id, corpo) e responde 200', async () => {
    const grantAccess = vi.fn().mockResolvedValue({
      user: { id: 'p1' },
      temporaryPassword: TEMP.grant,
    });
    const body = { email: 'maria@x.com', role: 'OPERATOR' } as const;
    const res = await new UsersController(
      makeService({ grantAccess }),
    ).grantAccess('p1', body, adminReq);
    expect(res.temporaryPassword).toBe(TEMP.grant);
    expect(grantAccess).toHaveBeenCalledWith('admin1', 'p1', body);
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, route('grantAccess'))).toBe(
      HttpStatus.OK,
    );
  });

  it.each(['OPERATOR', 'SUPERVISOR', 'VIEWER'])(
    'gestor (%s) em POST /users/:id/access → 403',
    (role) => {
      // A rota existe e herda o @Roles('ADMIN') da classe (sem override).
      expect(route('grantAccess')).toBeTypeOf('function');
      const context = {
        getHandler: () => route('grantAccess'),
        getClass: () => UsersController,
        switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
      } as unknown as ExecutionContext;
      expect(() =>
        new RolesGuard(new Reflector()).canActivate(context),
      ).toThrow(
        expect.objectContaining({
          status: 403,
          code: 'auth.insufficient_role',
        }),
      );
    },
  );
});
