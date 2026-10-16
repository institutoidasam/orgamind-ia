import { describe, it, expect, beforeEach } from 'vitest';
import { mockDeep, type DeepMockProxy } from 'vitest-mock-extended';
import { Prisma } from '@prisma/client';
import { UserPhoneService } from './user-phone.service';
import type { UsersRepository } from './users.repository';
import type { ContactsService } from '../contacts/contacts.service';
import type { ContactsRepository } from '../contacts/contacts.repository';
import { ContactPhoneConflictError } from '../contacts/errors/contacts.errors';

let users: DeepMockProxy<UsersRepository>;
let contacts: DeepMockProxy<ContactsService>;
let contactsRepo: DeepMockProxy<ContactsRepository>;
let svc: UserPhoneService;
const NINE = '+5592991234567';
const EIGHT = '+559291234567';
const caught = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (e: unknown) {
    return e;
  }
  return undefined;
};

beforeEach(() => {
  users = mockDeep();
  contacts = mockDeep();
  contactsRepo = mockDeep();
  svc = new UserPhoneService(users, contacts, contactsRepo);
});

describe('UserPhoneService.normalize/assertAvailable', () => {
  it('normaliza DDD sem +55 para E.164', () => {
    expect(svc.normalize('(92) 99123-4567')).toBe(NINE);
  });

  it('recusa número inválido com user.invalid_phone', () => {
    expect(caught(() => svc.normalize('123'))).toMatchObject({
      code: 'user.invalid_phone',
      status: 400,
    });
  });

  it('acusa user.phone_taken quando outro usuário tem a variante de 8 dígitos', async () => {
    users.findIdByPhoneVariants.mockResolvedValue('u-other');
    await expect(svc.assertAvailable(NINE, 'u-self')).rejects.toMatchObject({
      code: 'user.phone_taken',
      status: 409,
    });
    expect(users.findIdByPhoneVariants.mock.calls).toEqual([
      [expect.arrayContaining([NINE, EIGHT])],
    ]);
  });

  it('não acusa conflito com o próprio usuário', async () => {
    users.findIdByPhoneVariants.mockResolvedValue('u-self');
    await expect(svc.assertAvailable(NINE, 'u-self')).resolves.toBeUndefined();
  });
});

describe('UserPhoneService.resolveContactId', () => {
  it('contato existente com nome: só devolve o id (sem create/update)', async () => {
    contactsRepo.findByAnyBrForm.mockResolvedValue({
      id: 'c1',
      name: 'Planilha',
      phoneE164: EIGHT,
    } as never);
    await expect(svc.resolveContactId(NINE, 'Ana')).resolves.toBe('c1');
    expect(contacts.create.mock.calls).toHaveLength(0);
    expect(contacts.update.mock.calls).toHaveLength(0);
  });

  it('liga ao contato existente na outra grafia e preenche só o nome vazio', async () => {
    contactsRepo.findByAnyBrForm.mockResolvedValue({
      id: 'c1',
      name: null,
      phoneE164: EIGHT,
    } as never);
    await expect(svc.resolveContactId(NINE, 'Ana')).resolves.toBe('c1');
    expect(contactsRepo.findByAnyBrForm.mock.calls).toEqual([[NINE]]);
    expect(contacts.update.mock.calls).toEqual([['c1', { name: 'Ana' }]]);
  });

  it('sem contato: cria pelo ContactsService', async () => {
    contactsRepo.findByAnyBrForm.mockResolvedValue(null);
    contacts.create.mockResolvedValue({ id: 'c2' } as never);
    await expect(svc.resolveContactId(NINE, 'Ana')).resolves.toBe('c2');
    expect(contacts.create.mock.calls).toEqual([
      [expect.objectContaining({ phone: NINE, name: 'Ana' })],
    ]);
  });

  it('corrida no create: relê o contato que venceu', async () => {
    contactsRepo.findByAnyBrForm
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'c3', name: 'x' } as never);
    contacts.create.mockRejectedValue(new ContactPhoneConflictError(NINE));
    await expect(svc.resolveContactId(NINE, 'Ana')).resolves.toBe('c3');
  });

  it('erro que não é conflito de telefone sobe intacto', async () => {
    contactsRepo.findByAnyBrForm.mockResolvedValue(null);
    contacts.create.mockRejectedValue(new Error('boom'));
    await expect(svc.resolveContactId(NINE, 'Ana')).rejects.toThrow('boom');
  });
});

describe('UserPhoneService.isPhoneUniqueViolation', () => {
  const p2002 = (target: string[]) =>
    new Prisma.PrismaClientKnownRequestError('dup', {
      code: 'P2002',
      clientVersion: 'x',
      meta: { target },
    });

  it.each([['phoneE164'], ['contactId']])(
    'P2002 em %s é violação de telefone',
    (field) => {
      expect(UserPhoneService.isPhoneUniqueViolation(p2002([field]))).toBe(
        true,
      );
    },
  );

  it('P2002 em email não é', () => {
    expect(UserPhoneService.isPhoneUniqueViolation(p2002(['email']))).toBe(
      false,
    );
  });
});
