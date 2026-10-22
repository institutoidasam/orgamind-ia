import { Injectable } from '@nestjs/common';
import argon2 from 'argon2';
import { UsersRepository } from './users.repository';
import { UserPhoneService } from './user-phone.service';
import { AuditService } from '../../shared/audit/audit.service';
import { RefreshService } from '../auth/refresh.service';
import {
  ConflictError,
  DomainError,
  ForbiddenError,
  NotFoundError,
} from '../../shared/errors/domain.error';
import {
  accessSectorError,
  alreadyHasAccess,
  emailTaken,
  invalidLevel,
  nameRequired,
  noAccess,
} from './users.errors';
import type {
  UserListFilters,
  UserListResult,
  UserSummary,
} from './users.repository';
import { Prisma, type Role } from '@prisma/client';

export type UserListResponse = UserListResult & {
  page: number;
  pageSize: number;
};
type UserPatch = {
  name?: string;
  role?: Role;
  sectorId?: string | null;
  isActive?: boolean;
  /** Sem null: quem já tem telefone não pode apagá-lo; ausente = mantém. */
  phone?: string;
  /** Id de Shift. Ausente = mantém; null = limpa. Não é mudança de identidade. */
  shiftId?: string | null;
  /** Função. Ausente = mantém; null ou vazio = limpa. Não é mudança de identidade. */
  jobTitle?: string | null;
  /** Id de StaffLevel. Ausente = mantém; null = limpa. Não é mudança de identidade. */
  levelId?: string | null;
};
/** Pessoa sem acesso (D1/D12): POST /users com hasAccess false e a T6. */
type PersonWithoutAccessInput = {
  name: string;
  phone: string;
  sectorId: string | null;
  levelId?: string | null;
  jobTitle?: string | null;
  shiftId?: string | null;
};
type CreateUserInput = {
  email: string;
  name?: string;
  role: 'ADMIN' | 'OPERATOR' | 'SUPERVISOR' | 'VIEWER';
  sectorId?: string;
  phone: string;
  /** Id de Shift; ausente ou null = sem turno. */
  shiftId?: string | null;
  /** Função; ausente, null ou vazio = sem função. */
  jobTitle?: string | null;
  /** Id de StaffLevel; ausente ou null = sem nível. */
  levelId?: string | null;
};
type PhoneLink = { phoneE164: string; contactId: string };

// P2002 no e-mail ao dar acesso = outro cadastro ficou com o e-mail entre a
// checagem e o update → o mesmo 409 do convite.
function rethrowEmailConflict(error: unknown): never {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002' &&
    /email/.test(JSON.stringify(error.meta?.target ?? null))
  ) {
    throw emailTaken();
  }
  throw error;
}

// P2002 em phoneE164/contactId = dois cadastros do mesmo número em corrida (o
// assertAvailable de cada um passou antes do outro gravar) → user.phone_taken.
function rethrowPhoneConflict(error: unknown): never {
  if (UserPhoneService.isPhoneUniqueViolation(error)) {
    throw new ConflictError('Phone already taken', 'user.phone_taken');
  }
  throw error;
}

function invalidShift(): DomainError {
  return new DomainError({
    code: 'users.invalid_shift',
    message: 'Turno inválido',
    status: 422,
  });
}

// Função aparada; vazio (ou só espaços) grava null.
function normalizeJobTitle(value: string | null | undefined): string | null {
  return value?.trim() || null;
}

// Relação opcional no PATCH: id = liga; null (ou vazio) = desliga.
function relationPatch(id: string | null) {
  return id ? { connect: { id } } : { disconnect: true };
}

// Relação opcional no cadastro: id = liga; ausente/null = campo omitido.
function connectIfGiven(id: string | null | undefined) {
  return id ? { connect: { id } } : undefined;
}

// D1: sem acesso grava SEMPRE VIEWER, sem e-mail/senha e sem troca de senha
// pendente, qualquer que seja o input; a credencial só nasce em grantAccess.
function personWithoutAccessData(
  actorId: string,
  input: PersonWithoutAccessInput,
  phone: PhoneLink,
): Prisma.UserCreateInput {
  return {
    name: input.name.trim(),
    hasAccess: false,
    role: 'VIEWER',
    email: null,
    password: null,
    mustChangePassword: false,
    phoneE164: phone.phoneE164,
    contact: { connect: { id: phone.contactId } },
    sector: connectIfGiven(input.sectorId),
    level: connectIfGiven(input.levelId),
    workShift: connectIfGiven(input.shiftId),
    jobTitle: normalizeJobTitle(input.jobTitle),
    createdBy: { connect: { id: actorId } },
  };
}

// Defense-in-depth: strip any unexpected fields that the repo might leak (e.g.
// if a future change accidentally swaps the allowlisted select back to a full
// include). The repo already returns UserSummary; this enforces the contract.
function toUserSummary(u: UserSummary): UserSummary {
  return {
    id: u.id,
    email: u.email,
    hasAccess: u.hasAccess,
    name: u.name,
    role: u.role,
    sectorId: u.sectorId,
    sector: u.sector,
    isActive: u.isActive,
    sessionVersion: u.sessionVersion,
    mustChangePassword: u.mustChangePassword,
    lastLoginAt: u.lastLoginAt,
    phoneE164: u.phoneE164,
    shiftId: u.shiftId,
    jobTitle: u.jobTitle,
    levelId: u.levelId,
    level: u.level,
    createdAt: u.createdAt,
    updatedAt: u.updatedAt,
    createdById: u.createdById,
    createdBy: u.createdBy,
  };
}

// Regra de hoje para quem tem acesso: papel final ≠ ADMIN, ativo, sem setor.
function lacksRequiredSector(user: UserSummary, input: UserPatch): boolean {
  const role = input.role ?? user.role;
  const sectorId =
    input.sectorId === undefined ? user.sectorId : input.sectorId;
  return role !== 'ADMIN' && input.isActive !== false && !sectorId;
}

// Pessoa sem acesso (spec §1) não pode ficar sem nome: é o que a identifica,
// já que não tem e-mail. Quem tem acesso segue aceitando vazio, como hoje.
function assertNameKept(user: UserSummary, name: string | undefined): void {
  if (!user.hasAccess && name?.trim() === '') throw nameRequired();
}

// Nome do contato: o novo do PATCH, senão o atual, senão o e-mail; pessoa sem
// acesso (C2) não tem e-mail, mas sempre tem nome.
function contactNameFor(
  user: UserSummary,
  newName: string | undefined,
): string {
  return newName?.trim() || user.name?.trim() || (user.email ?? '');
}

@Injectable()
export class UsersService {
  constructor(
    private readonly repo: UsersRepository,
    private readonly audit: AuditService,
    private readonly refresh: RefreshService,
    private readonly phones: UserPhoneService,
  ) {}

  async listUsers(
    page: number,
    pageSize: number,
    filters: UserListFilters = {},
  ): Promise<UserListResponse> {
    const { data, total } = await this.repo.findMany(page, pageSize, filters);
    return { data: data.map(toUserSummary), total, page, pageSize };
  }

  async createUser(
    input: CreateUserInput,
    createdById: string,
  ): Promise<{ user: UserSummary | null; temporaryPassword: string }> {
    const phoneE164 = this.phones.normalize(input.phone);
    const existing = await this.repo.findByEmail(input.email);
    await this.assertCreatable(input, existing);
    await this.assertAssignableShift(input.shiftId);
    await this.assertAssignableLevel(input.levelId, null);
    await this.phones.assertAvailable(phoneE164);
    const temporaryPassword = UsersRepository.generateTempPassword();
    const passwordHash = await argon2.hash(temporaryPassword, {
      type: argon2.argon2id,
    });
    // M7 (risco aceito): o contato é resolvido ANTES de gravar o usuário; numa
    // corrida de e-mail ele fica sem usuário, mas é um Contact legítimo do
    // número (ver UserPhoneService.resolveContactId).
    const contactId = await this.phones.resolveContactId(
      phoneE164,
      input.name?.trim() || input.email,
    );
    const created = await this.createInvitation(
      input,
      createdById,
      passwordHash,
      {
        phoneE164,
        contactId,
      },
    );

    await this.audit.log('user.invited', 'User', created.id, {
      email: created.email,
      role: created.role,
      invitedBy: createdById,
    });

    // Re-read via findById to get the password-free UserSummary shape.
    const user = await this.repo.findById(created.id);
    return { user: user ? toUserSummary(user) : null, temporaryPassword };
  }

  private async assertCreatable(
    input: CreateUserInput,
    existing: Awaited<ReturnType<UsersRepository['findByEmail']>>,
  ): Promise<void> {
    if (existing) throw emailTaken();
    if (input.role === 'ADMIN') return;
    if (
      !input.sectorId ||
      !(await this.repo.findActiveSector(input.sectorId))
    ) {
      throw new ConflictError(
        'An active sector is required',
        'user.sector_required',
      );
    }
  }

  private createInvitation(
    input: CreateUserInput,
    createdById: string,
    password: string,
    phone: PhoneLink,
  ) {
    return this.repo
      .create({
        email: input.email,
        name: input.name ?? null,
        role: input.role,
        ...(input.sectorId
          ? { sector: { connect: { id: input.sectorId } } }
          : {}),
        password,
        mustChangePassword: true,
        phoneE164: phone.phoneE164,
        contact: { connect: { id: phone.contactId } },
        jobTitle: normalizeJobTitle(input.jobTitle),
        ...(input.shiftId
          ? { workShift: { connect: { id: input.shiftId } } }
          : {}),
        level: connectIfGiven(input.levelId),
        createdBy: { connect: { id: createdById } },
      })
      .catch(rethrowPhoneConflict);
  }

  /**
   * Pessoa sem acesso (D1): sem credencial e sem senha temporária. O telefone
   * passa pelo mesmo caminho do convite (`UserPhoneService`): número de outra
   * pessoa é recusado e o de um Contato existente liga a pessoa a ele.
   */
  async createPersonWithoutAccess(
    actorId: string,
    input: PersonWithoutAccessInput,
  ): Promise<UserSummary> {
    const phoneE164 = this.phones.normalize(input.phone);
    await this.assertActiveSectorIfGiven(input.sectorId);
    await this.assertAssignableShift(input.shiftId);
    await this.assertAssignableLevel(input.levelId, null);
    await this.phones.assertAvailable(phoneE164);
    const contactId = await this.phones.resolveContactId(
      phoneE164,
      input.name.trim(),
    );
    const user = await this.repo
      .createSummary(
        personWithoutAccessData(actorId, input, { phoneE164, contactId }),
      )
      .catch(rethrowPhoneConflict);
    // GC8: sem nome, e-mail ou telefone na auditoria.
    await this.audit.log('user.person_created', 'User', user.id, {
      actorId,
      sectorId: user.sectorId,
      hasAccess: false,
    });
    return toUserSummary(user);
  }

  /**
   * Dá acesso a uma pessoa sem acesso (D1): e-mail, papel, hash da senha
   * temporária, `mustChangePassword` e `hasAccess` num único update. A senha
   * temporária só volta nesta resposta; nunca vai para log ou auditoria.
   */
  async grantAccess(
    actorId: string,
    userId: string,
    input: { email: string; role: Role },
  ): Promise<{ user: UserSummary; temporaryPassword: string }> {
    const user = await this.repo.findById(userId);
    if (!user) throw new NotFoundError('User', userId);
    if (user.hasAccess) throw alreadyHasAccess();
    const email = input.email.trim().toLowerCase();
    if (await this.repo.findByEmail(email)) throw emailTaken();
    await this.assertSectorForAccess(input.role, user.sectorId);
    const temporaryPassword = UsersRepository.generateTempPassword();
    const password = await argon2.hash(temporaryPassword, {
      type: argon2.argon2id,
    });
    const granted = await this.repo
      .grantAccess(userId, {
        email,
        role: input.role,
        password,
        mustChangePassword: true,
        hasAccess: true,
      })
      .catch(rethrowEmailConflict);
    // Null = outro pedido deu acesso entre a leitura e o update.
    if (!granted) throw alreadyHasAccess();
    await this.audit.log('user.access_granted', 'User', userId, {
      actorId,
      role: input.role,
    });
    return { user: toUserSummary(granted), temporaryPassword };
  }

  /** Papel ≠ ADMIN exige setor ativo (regra do convite), com o 422 de C2. */
  private async assertSectorForAccess(
    role: Role,
    sectorId: string | null,
  ): Promise<void> {
    if (role === 'ADMIN') return;
    if (!sectorId) throw accessSectorError('user.sector_required');
    if (!(await this.repo.findActiveSector(sectorId)))
      throw accessSectorError('user.sector_invalid');
  }

  async updateUser(
    id: string,
    input: UserPatch,
    actorId: string,
  ): Promise<void> {
    const user = await this.repo.findById(id);
    if (!user) throw new NotFoundError('User', id);

    this.assertSelfChangeAllowed(id, actorId, input);
    assertNameKept(user, input.name);
    await this.assertValidAssignment(user, input);
    await this.assertAssignableShift(input.shiftId);
    const changesIdentity = this.changesIdentity(input);
    const data = {
      ...this.toUpdateData(input, changesIdentity),
      ...(await this.phoneUpdate(user, input.phone, input.name)),
    };

    // Transactional update with last-admin guard. Two concurrent demotions of
    // the only two admins would otherwise both pass a separate countAdmins
    // check; the serializable transaction prevents that race.
    const result = await this.lastAdminGuard(() =>
      this.repo.updateWithLastAdminGuard(id, data),
    );
    if ('lastAdmin' in result) {
      throw new ForbiddenError(
        'Cannot demote the last admin',
        'user.last_admin',
      );
    }

    if (changesIdentity) {
      // A privilege change must not leave the old role cached in a live access
      // token (valid up to 15min): force re-login so the new role takes effect.
      await this.refresh.revokeAllForUser(id);
      await this.audit.log('user.role_changed', 'User', id, {
        newRole: input.role,
        sectorId: input.sectorId,
        isActive: input.isActive,
        changedBy: actorId,
      });
    } else {
      await this.audit.log('user.profile_updated', 'User', id, {
        changedBy: actorId,
      });
    }
  }

  private assertSelfChangeAllowed(
    id: string,
    actorId: string,
    input: UserPatch,
  ): void {
    if (id !== actorId) return;
    if (input.role !== undefined)
      throw new ForbiddenError(
        'Cannot edit your own role',
        'user.cannot_self_edit_role',
      );
    if (input.isActive === false)
      throw new ForbiddenError(
        'Cannot deactivate yourself',
        'user.cannot_self_deactivate',
      );
  }

  private async assertValidAssignment(
    user: UserSummary,
    input: UserPatch,
  ): Promise<void> {
    // Sem acesso não tem papel a mudar: o VIEWER gravado é defesa (D1).
    if (input.role !== undefined && !user.hasAccess) throw noAccess();
    await this.assertActiveSectorIfGiven(input.sectorId);
    // "Não-ADMIN exige setor" só vale para quem tem acesso (C2).
    if (user.hasAccess && lacksRequiredSector(user, input))
      throw new ConflictError(
        'An active sector is required',
        'user.sector_required',
      );
    await this.assertAssignableLevel(input.levelId, user.levelId);
  }

  /** Setor informado (string) precisa existir e estar ativo; ausente/null passa. */
  private async assertActiveSectorIfGiven(
    sectorId: string | null | undefined,
  ): Promise<void> {
    if (sectorId && !(await this.repo.findActiveSector(sectorId)))
      throw new ConflictError(
        'Sector is inactive or missing',
        'user.sector_invalid',
      );
  }

  /**
   * Nível informado precisa existir e estar ativo; o nível inativo que a
   * pessoa já tem é aceito (manter não é atribuir). Ausente/null passa.
   */
  private async assertAssignableLevel(
    levelId: string | null | undefined,
    currentLevelId: string | null,
  ): Promise<void> {
    if (!levelId) return;
    const level = await this.repo.findLevelForAssignment(levelId);
    if (!level || (!level.isActive && level.id !== currentLevelId))
      throw invalidLevel();
  }

  /** Turno informado (string) precisa existir e estar ativo; ausente/null passa. */
  private async assertAssignableShift(
    shiftId: string | null | undefined,
  ): Promise<void> {
    if (!shiftId) return;
    const shift = await this.repo.findShiftForAssignment(shiftId);
    if (!shift?.isActive) throw invalidShift();
  }

  private changesIdentity(input: UserPatch): boolean {
    return (
      input.role !== undefined ||
      input.sectorId !== undefined ||
      input.isActive !== undefined
    );
  }

  private toUpdateData(
    input: UserPatch,
    changesIdentity: boolean,
  ): Prisma.UserUpdateInput {
    return {
      ...(input.name !== undefined ? { name: input.name.trim() } : {}),
      ...(input.role !== undefined ? { role: input.role } : {}),
      ...(input.sectorId !== undefined
        ? { sector: relationPatch(input.sectorId) }
        : {}),
      ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      ...(input.shiftId !== undefined
        ? { workShift: relationPatch(input.shiftId) }
        : {}),
      ...(input.jobTitle !== undefined
        ? { jobTitle: normalizeJobTitle(input.jobTitle) }
        : {}),
      ...(input.levelId !== undefined
        ? { level: relationPatch(input.levelId) }
        : {}),
      ...(changesIdentity ? { sessionVersion: { increment: 1 } } : {}),
    };
  }

  /**
   * Telefone do PATCH → dados do Prisma. Ausente = mantém. Mesmo número com
   * contato ligado = nada a fazer; mesmo número sem contato (apagado, SetNull)
   * = só religa. Número novo = confere titular e religa ao contato dele (o
   * contato antigo fica). O telefone não vai para a auditoria. Nome do contato:
   * o novo do PATCH, senão o atual, senão o e-mail (só preenche nome vazio).
   */
  private async phoneUpdate(
    user: UserSummary,
    raw: string | undefined,
    newName: string | undefined,
  ): Promise<Prisma.UserUpdateInput> {
    if (raw === undefined) return {};
    const phoneE164 = this.phones.normalize(raw);
    const sameNumber = phoneE164 === user.phoneE164;
    if (sameNumber && (await this.repo.findContactId(user.id))) return {};
    if (!sameNumber) await this.phones.assertAvailable(phoneE164, user.id);
    const contactId = await this.phones.resolveContactId(
      phoneE164,
      contactNameFor(user, newName),
    );
    const contact = { connect: { id: contactId } };
    return sameNumber ? { contact } : { phoneE164, contact };
  }

  private async lastAdminGuard<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2034'
      ) {
        throw new ConflictError(
          'Concurrent administrator change, retry the request',
          'user.concurrent_admin_change',
        );
      }
      rethrowPhoneConflict(error);
    }
  }

  async deleteUser(id: string, actorId: string): Promise<void> {
    const user = await this.repo.findById(id);
    if (!user) throw new NotFoundError('User', id);

    if (id === actorId) {
      throw new ForbiddenError(
        'Cannot delete yourself',
        'user.cannot_delete_self',
      );
    }

    // Transactional delete with last-admin guard against concurrent races.
    const result = await this.lastAdminGuard(() =>
      this.repo.deleteWithLastAdminGuard(id),
    );
    if ('lastAdmin' in result) {
      throw new ForbiddenError(
        'Cannot delete the last admin',
        'user.last_admin',
      );
    }

    // Burn any lingering refresh families so a deleted user's token can't keep
    // rotating until the 7-day family TTL lapses.
    await this.refresh.revokeAllForUser(id);

    await this.audit.log('user.deleted', 'User', id, {
      email: user.email,
      deletedBy: actorId,
    });
  }

  async resetPassword(
    id: string,
    actorId: string,
  ): Promise<{ temporaryPassword: string }> {
    const user = await this.repo.findById(id);
    if (!user) throw new NotFoundError('User', id);
    // Antes de qualquer gravação: sem acesso não há senha (o CHECK
    // User_access_consistent recusaria senha sem acesso com 500).
    if (!user.hasAccess) throw noAccess();

    const temporaryPassword = UsersRepository.generateTempPassword();
    const passwordHash = await argon2.hash(temporaryPassword, {
      type: argon2.argon2id,
    });
    await this.repo.resetPassword(id, passwordHash);
    // Same reasoning as self-service change: invalidate every existing session
    // so the old credential's refresh tokens stop rotating.
    await this.refresh.revokeAllForUser(id);
    await this.audit.log('user.password_reset', 'User', id, {
      resetBy: actorId,
    });

    return { temporaryPassword };
  }
}
