import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockDeep, type DeepMockProxy } from 'vitest-mock-extended';
import argon2 from 'argon2';
import { Prisma } from '@prisma/client';
import { UsersService } from './users.service';
import { UserPhoneService } from './user-phone.service';
import type { UsersRepository, UserSummary } from './users.repository';
import type { AuditService } from '../../shared/audit/audit.service';
import type { RefreshService } from '../auth/refresh.service';
import { ValidationError } from '../../shared/errors/domain.error';

vi.mock('argon2');

const NINE = '+5592991234567';
const OLD = '+5592988887777';
let repo: DeepMockProxy<UsersRepository>;
let audit: DeepMockProxy<AuditService>;
let refresh: DeepMockProxy<RefreshService>;
let phones: DeepMockProxy<UserPhoneService>;
let svc: UsersService;

const p2002 = (field: string) =>
  new Prisma.PrismaClientKnownRequestError('dup', {
    code: 'P2002',
    clientVersion: 'x',
    meta: { target: [field] },
  });
const user = (phoneE164: string | null) =>
  ({
    id: 'u1',
    email: 'u1@b.com',
    name: null,
    role: 'ADMIN',
    sectorId: null,
    phoneE164,
  }) as unknown as UserSummary;
const patchData = () => repo.updateWithLastAdminGuard.mock.calls[0]?.[1];

beforeEach(() => {
  repo = mockDeep();
  audit = mockDeep();
  refresh = mockDeep();
  phones = mockDeep();
  svc = new UsersService(repo, audit, refresh, phones);
  vi.mocked(argon2.hash).mockResolvedValue('hashed');
  repo.findByEmail.mockResolvedValue(null);
  repo.create.mockResolvedValue({
    id: 'u-new',
    email: 'a@b.com',
    role: 'ADMIN',
  } as never);
  repo.updateWithLastAdminGuard.mockResolvedValue({ updated: {} } as never);
  phones.normalize.mockReturnValue(NINE);
  phones.resolveContactId.mockResolvedValue('c1');
});

describe('UsersService.createUser — telefone', () => {
  const invite = () =>
    svc.createUser(
      { email: 'a@b.com', role: 'ADMIN', phone: '(92) 99123-4567' },
      'admin',
    );

  it('cadastra com telefone normalizado ligado ao contato', async () => {
    await invite();
    expect(phones.assertAvailable.mock.calls).toEqual([[NINE]]);
    expect(phones.resolveContactId.mock.calls).toEqual([[NINE, 'a@b.com']]);
    expect(repo.create.mock.calls).toEqual([
      [
        expect.objectContaining({
          phoneE164: NINE,
          contact: { connect: { id: 'c1' } },
        }),
      ],
    ]);
    expect(JSON.stringify(audit.log.mock.calls)).not.toContain(NINE);
  });

  it('telefone inválido não cria nada', async () => {
    phones.normalize.mockImplementation(() => {
      throw new ValidationError(
        'Telefone inválido',
        undefined,
        'user.invalid_phone',
      );
    });
    await expect(invite()).rejects.toMatchObject({
      code: 'user.invalid_phone',
    });
    expect(repo.create.mock.calls).toHaveLength(0);
    expect(phones.resolveContactId.mock.calls).toHaveLength(0);
  });

  it('P2002 de phoneE164 no create vira user.phone_taken', async () => {
    repo.create.mockRejectedValue(p2002('phoneE164'));
    await expect(invite()).rejects.toMatchObject({ code: 'user.phone_taken' });
  });

  it('P2002 de email no create sobe intacto', async () => {
    repo.create.mockRejectedValue(p2002('email'));
    await expect(invite()).rejects.toBeInstanceOf(
      Prisma.PrismaClientKnownRequestError,
    );
  });
});

describe('UsersService.updateUser — telefone', () => {
  it('PATCH troca o número e religa ao contato do número novo', async () => {
    repo.findById.mockResolvedValue(user(OLD));
    await svc.updateUser('u1', { phone: '92991234567' }, 'admin');
    expect(phones.assertAvailable.mock.calls).toEqual([[NINE, 'u1']]);
    expect(phones.resolveContactId.mock.calls).toEqual([[NINE, 'u1@b.com']]);
    expect(patchData()).toEqual(
      expect.objectContaining({
        phoneE164: NINE,
        contact: { connect: { id: 'c1' } },
      }),
    );
    expect(JSON.stringify(audit.log.mock.calls)).not.toContain(NINE);
  });

  it('PATCH com o mesmo número e contato ligado não religa', async () => {
    repo.findById.mockResolvedValue(user(NINE));
    repo.findContactId.mockResolvedValue('c0');
    await svc.updateUser('u1', { phone: '92991234567' }, 'admin');
    expect(phones.resolveContactId.mock.calls).toHaveLength(0);
    expect(patchData()).not.toHaveProperty('phoneE164');
    expect(patchData()).not.toHaveProperty('contact');
  });

  it('PATCH com o mesmo número e contactId null religa ao contato', async () => {
    repo.findById.mockResolvedValue(user(NINE));
    repo.findContactId.mockResolvedValue(null);
    await svc.updateUser('u1', { phone: '92991234567' }, 'admin');
    expect(phones.resolveContactId.mock.calls).toEqual([[NINE, 'u1@b.com']]);
    expect(patchData()).toEqual({ contact: { connect: { id: 'c1' } } });
  });

  it('usuário antigo sem telefone continua sem', async () => {
    repo.findById.mockResolvedValue(user(null));
    await svc.updateUser('u1', { name: 'X' }, 'admin');
    expect(phones.normalize.mock.calls).toHaveLength(0);
    expect(patchData()).toEqual({ name: 'X' });
  });

  it('P2002 de phoneE164 no PATCH vira user.phone_taken', async () => {
    repo.findById.mockResolvedValue(user(OLD));
    repo.updateWithLastAdminGuard.mockRejectedValue(p2002('phoneE164'));
    await expect(
      svc.updateUser('u1', { phone: '92991234567' }, 'admin'),
    ).rejects.toMatchObject({
      code: 'user.phone_taken',
    });
  });
});

describe('UsersService.updateUser — nome do contato', () => {
  it('PATCH com phone e name usa o nome novo no contato', async () => {
    repo.findById.mockResolvedValue(user(OLD));
    await svc.updateUser('u1', { phone: '92991234567', name: 'Ana' }, 'admin');
    expect(phones.resolveContactId.mock.calls).toEqual([[NINE, 'Ana']]);
    expect(patchData()).toEqual(
      expect.objectContaining({ name: 'Ana', phoneE164: NINE }),
    );
  });

  it.each([
    [' Ana ', 'Ana'],
    ['  ', 'u1@b.com'],
  ])('name %j vira %j no contato', async (name, expected) => {
    repo.findById.mockResolvedValue(user(OLD));
    await svc.updateUser('u1', { phone: '92991234567', name }, 'admin');
    expect(phones.resolveContactId.mock.calls).toEqual([[NINE, expected]]);
  });
});
