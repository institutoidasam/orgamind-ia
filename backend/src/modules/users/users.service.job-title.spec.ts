import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockDeep, type DeepMockProxy } from 'vitest-mock-extended';
import argon2 from 'argon2';
import { UsersService } from './users.service';
import type { UserPhoneService } from './user-phone.service';
import type { UsersRepository, UserSummary } from './users.repository';
import type { AuditService } from '../../shared/audit/audit.service';
import type { RefreshService } from '../auth/refresh.service';
import { createUserSchema } from './dto/create-user.dto';
import { updateUserSchema } from './dto/update-user.dto';
import { userListResponseSchema } from '../../schemas/contracts/user.schema';

vi.mock('argon2');

let repo: DeepMockProxy<UsersRepository>;
let refresh: DeepMockProxy<RefreshService>;
let svc: UsersService;

const operator = {
  id: 'u7',
  email: 'operador@idasam.org',
  name: 'Bia',
  role: 'OPERATOR',
  sectorId: 'sec_producao',
  sector: null,
  isActive: true,
  lastLoginAt: null,
  phoneE164: null,
  shiftId: null,
  jobTitle: 'Operador de empilhadeira',
  createdAt: new Date('2026-10-21T12:00:00Z'),
  createdBy: null,
} as unknown as UserSummary;

const invite = (jobTitle: string | null) =>
  svc.createUser(
    { email: 'b@idasam.org', role: 'ADMIN', phone: '92991234567', jobTitle },
    'admin',
  );
const created = () => repo.create.mock.calls[0]?.[0];
const patched = () => repo.updateWithLastAdminGuard.mock.calls[0]?.[1];

beforeEach(() => {
  repo = mockDeep();
  refresh = mockDeep();
  const phones = mockDeep<UserPhoneService>();
  svc = new UsersService(repo, mockDeep<AuditService>(), refresh, phones);
  vi.mocked(argon2.hash).mockResolvedValue('hashed');
  phones.normalize.mockReturnValue('+5592991234567');
  phones.resolveContactId.mockResolvedValue('c7');
  repo.findByEmail.mockResolvedValue(null);
  repo.create.mockResolvedValue({
    id: 'u-new',
    email: 'b@idasam.org',
  } as never);
  repo.findById.mockResolvedValue(operator);
  repo.updateWithLastAdminGuard.mockResolvedValue({ updated: {} } as never);
});

describe('UsersService — função (jobTitle) no cadastro', () => {
  it("POST com jobTitle '  Operador de empilhadeira  ' grava sem espaços", async () => {
    await invite('  Operador de empilhadeira  ');
    expect(created()).toMatchObject({ jobTitle: 'Operador de empilhadeira' });
  });

  it("jobTitle '' grava null", async () => {
    await invite('');
    expect(created()).toMatchObject({ jobTitle: null });
  });

  it('listUsers devolve jobTitle e passa no contrato', async () => {
    repo.findMany.mockResolvedValue({ data: [operator], total: 1 });
    const res = await svc.listUsers(1, 20);
    const wire = userListResponseSchema.parse(JSON.parse(JSON.stringify(res)));
    expect(wire.data[0]?.jobTitle).toBe('Operador de empilhadeira');
  });
});

describe('UsersService — função (jobTitle) na edição', () => {
  it('PATCH sem jobTitle não envia jobTitle', async () => {
    await svc.updateUser('u7', { name: 'Bia Souza' }, 'admin');
    expect(patched()).toEqual({ name: 'Bia Souza' });
  });

  it('PATCH jobTitle null limpa e não revoga sessão', async () => {
    await svc.updateUser('u7', { jobTitle: null }, 'admin');
    expect(patched()).toEqual({ jobTitle: null });
    expect(refresh.revokeAllForUser.mock.calls).toEqual([]);
  });
});

describe('DTOs de usuário — jobTitle', () => {
  const base = { email: 'b@idasam.org', phone: '92991234567' };
  it.each<[string, () => { success: boolean }, boolean]>([
    [
      'POST jobTitle com 81 caracteres → falha de validação',
      () => createUserSchema.safeParse({ ...base, jobTitle: 'x'.repeat(81) }),
      false,
    ],
    [
      'POST 80 caracteres entre espaços passa',
      () =>
        createUserSchema.safeParse({
          ...base,
          jobTitle: ` ${'x'.repeat(80)} `,
        }),
      true,
    ],
    [
      'PATCH jobTitle com 81 caracteres → falha de validação',
      () => updateUserSchema.safeParse({ jobTitle: 'x'.repeat(81) }),
      false,
    ],
    [
      'PATCH só { jobTitle } é válido',
      () => updateUserSchema.safeParse({ jobTitle: 'Auxiliar' }),
      true,
    ],
    [
      'PATCH só { jobTitle: null } é válido',
      () => updateUserSchema.safeParse({ jobTitle: null }),
      true,
    ],
    [
      'PATCH vazio continua inválido',
      () => updateUserSchema.safeParse({}),
      false,
    ],
  ])('%s', (_, parse, ok) => {
    expect(parse().success).toBe(ok);
  });

  it('createUserSchema apara jobTitle', () => {
    const parsed = createUserSchema.parse({
      ...base,
      jobTitle: '  Auxiliar  ',
    });
    expect(parsed.jobTitle).toBe('Auxiliar');
  });
});
