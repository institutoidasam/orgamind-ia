import { describe, it, expect, vi } from 'vitest';
import { HttpStatus } from '@nestjs/common';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { ForbiddenError } from '../../shared/errors/domain.error';

const makeService = (overrides: Partial<InstanceType<typeof UsersService>> = {}) =>
  ({
    listUsers: vi.fn().mockResolvedValue({ data: [], total: 0 }),
    createUser: vi.fn().mockResolvedValue({ user: {}, temporaryPassword: 'TmpPwd12345x' }),
    updateUser: vi.fn().mockResolvedValue(undefined),
    deleteUser: vi.fn().mockResolvedValue(undefined),
    resetPassword: vi.fn().mockResolvedValue({ temporaryPassword: 'NewTmp12345x' }),
    ...overrides,
  }) as unknown as UsersService;

const adminReq = { user: { sub: 'admin1', role: 'ADMIN' } } as never;

describe('UsersController', () => {
  it('GET /users delegates to service.listUsers', async () => {
    const svc = makeService();
    const ctrl = new UsersController(svc);
    await ctrl.listUsers({ page: 1, pageSize: 20 }, adminReq);
    expect(svc.listUsers).toHaveBeenCalledWith(1, 20);
  });

  it('POST /users returns user + temporaryPassword', async () => {
    const ctrl = new UsersController(makeService());
    const result = await ctrl.createUser({ email: 'new@x.com', role: 'OPERATOR' }, adminReq);
    expect(result).toHaveProperty('temporaryPassword');
  });

  it('PATCH /users/:id delegates actorId from JWT', async () => {
    const svc = makeService();
    const ctrl = new UsersController(svc);
    await ctrl.updateUser('u2', { name: 'New' }, adminReq);
    expect(svc.updateUser).toHaveBeenCalledWith('u2', { name: 'New' }, 'admin1');
  });

  it('PATCH /users/:id is declared 204 No Content (empty-body contract — frontend must not .json() it)', () => {
    // @HttpCode is reflected metadata, not observable from a direct method call,
    // so assert the metadata directly. Removing the decorator regresses the
    // "Unexpected end of JSON input" bug, so this guards the backend half.
    expect(
      Reflect.getMetadata(
        HTTP_CODE_METADATA,
        UsersController.prototype.updateUser,
      ),
    ).toBe(HttpStatus.NO_CONTENT);
  });

  it('POST /users/:id/reset-password returns temporaryPassword', async () => {
    const ctrl = new UsersController(makeService());
    const res = await ctrl.resetPassword('u2', adminReq);
    expect(res.temporaryPassword).toBe('NewTmp12345x');
  });

  it('DELETE /users/:id delegates to service.deleteUser', async () => {
    const svc = makeService();
    const ctrl = new UsersController(svc);
    await ctrl.deleteUser('u2', adminReq);
    expect(svc.deleteUser).toHaveBeenCalledWith('u2', 'admin1');
  });
});
