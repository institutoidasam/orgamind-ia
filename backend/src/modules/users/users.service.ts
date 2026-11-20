import { Injectable } from '@nestjs/common';
import argon2 from 'argon2';
import { UsersRepository } from './users.repository';
import { UserPhoneService } from './user-phone.service';
import { AuditService } from '../../shared/audit/audit.service';
import { RefreshService } from '../auth/refresh.service';
import { canDeletePerson } from '../../shared/authz/person-actions.policy';
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
  hasHistory,
  invalidLevel,
  nameRequired,
  noAccess,
  registrationTaken,
} from './users.errors';
import type {
  AssignmentChange,
  PersonDeleteTrail,
  PersonUpdateTrail,
  UserListFilters,
  UserListResult,
  UserSummary,
} from './users.repository';
import {
  authorizationColumns,
  normalizeRegistration,
  rethrowRegistrationConflict,
  toContactAuthorization,
  type AuthorizationColumns,
  type AuthorizationRow,
} from './person-record';
import { personAuditChanges, personChangeAction } from './person-audit';
import type { AssignmentPatch, AssignmentValues } from './assignment-timeline';
import { isOpenAssignmentConflict } from './assignment-writer';
import { todayIn } from '../staff-schedule/civil-date';
import type {
  ContactAuthorization,
  ContactAuthorizationInput,
} from '../../schemas/contracts/contact-authorization.schema';
import { Prisma, type AuditCategory, type Role } from '@prisma/client';

/** A pessoa como a API a devolve (C5): a autorização sai agrupada, não em colunas. */
export type UserView = Omit<UserSummary, keyof AuthorizationRow> & {
  contactAuthorization: ContactAuthorization;
};
export type UserListResponse = Omit<UserListResult, 'data'> & {
  data: UserView[];
  page: number;
  pageSize: number;
  authorizationCounts: { unverified: number; notAuthorized: number };
};
export type UserPatch = {
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
  /** Matrícula (A1). Ausente = mantém; null ou vazio = limpa. */
  registration?: string | null;
  /** Autorização de contato (A2). Ausente = mantém; igual à atual = nada a gravar (D17). */
  contactAuthorization?: ContactAuthorizationInput;
};
/**
 * Contexto da mudança para a trilha (C5): o motivo (A4) e, para quem edita em
 * nome de outra tela (setor), a ação e a categoria que substituem as derivadas.
 */
export type PersonChangeMeta = {
  reason: string | null;
  action?: string;
  category?: AuditCategory;
};
/**
 * Meta da criação de pessoa sem acesso: o motivo vai para a trilha e `personId`
 * (só a importação, EX17.4 a) vira o `id` da pessoa criada; sem ele o `id`
 * continua do `@default(cuid())`.
 */
export type PersonCreateMeta = Pick<PersonChangeMeta, 'reason'> & {
  personId?: string;
};
/** Ficha da criação (A1/A2): sem `contactAuthorization` a pessoa nasce NAO_AUTORIZADO. */
type PersonRecordInput = {
  registration?: string | null;
  contactAuthorization?: ContactAuthorizationInput;
};
/** Pessoa sem acesso (D1/D12): POST /users com hasAccess false e a T6. */
export type PersonWithoutAccessInput = PersonRecordInput & {
  name: string;
  phone: string;
  sectorId: string | null;
  levelId?: string | null;
  jobTitle?: string | null;
  shiftId?: string | null;
};
type CreateUserInput = PersonRecordInput & {
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
/** Matrícula e autorização já resolvidas, prontas para as colunas da criação. */
type PersonRecord = ReturnType<typeof normalizeRegistration> &
  Partial<AuthorizationColumns>;
type LinkedRecord = PhoneLink & { record: PersonRecord };

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

// P2002 do telefone ou da matrícula na edição → o erro próprio de cada um.
function rethrowUniqueConflict(error: unknown): never {
  try {
    rethrowPhoneConflict(error);
  } catch (mapped) {
    rethrowRegistrationConflict(mapped);
  }
}

function invalidShift(): DomainError {
  return new DomainError({
    code: 'users.invalid_shift',
    message: 'Turno inválido',
    status: 422,
  });
}

// Função aparada; vazio (ou só espaços) grava null.
export function normalizeJobTitle(
  value: string | null | undefined,
): string | null {
  return value?.trim() || null;
}

// Vínculo da criação (DV6): os três sempre; ausente, null ou vazio = null.
// Nunca vai em `data`: só pelo parâmetro do repositório (DV5/DV15).
function creationAssignment(input: {
  sectorId?: string | null;
  shiftId?: string | null;
  levelId?: string | null;
}): AssignmentValues {
  return {
    sectorId: input.sectorId || null,
    shiftId: input.shiftId || null,
    levelId: input.levelId || null,
  };
}

// Vínculo do PATCH (CV2): só as chaves presentes (ausente = mantém); null ou
// vazio = limpa; nenhuma chave de vínculo = undefined (o vínculo não é tocado).
function assignmentPatch(input: UserPatch): AssignmentPatch | undefined {
  const patch: AssignmentPatch = {};
  if (input.sectorId !== undefined) patch.sectorId = input.sectorId || null;
  if (input.shiftId !== undefined) patch.shiftId = input.shiftId || null;
  if (input.levelId !== undefined) patch.levelId = input.levelId || null;
  return Object.keys(patch).length > 0 ? patch : undefined;
}

// Troca de vínculo da edição: o "hoje" de Manaus calculado uma vez por
// operação (DV7); sem chave de vínculo no PATCH, sem assignment.
function assignmentChange(
  input: UserPatch,
  actorId: string,
): AssignmentChange | undefined {
  const patch = assignmentPatch(input);
  return patch && { patch, today: todayIn(new Date()), actorId };
}

// D1: sem acesso grava SEMPRE VIEWER, sem e-mail/senha e sem troca de senha
// pendente, qualquer que seja o input; a credencial só nasce em grantAccess.
function personWithoutAccessData(
  actorId: string,
  input: PersonWithoutAccessInput,
  linked: LinkedRecord,
  personId?: string,
): Prisma.UserCreateInput {
  return {
    ...(personId ? { id: personId } : {}),
    name: input.name.trim(),
    hasAccess: false,
    role: 'VIEWER',
    email: null,
    password: null,
    mustChangePassword: false,
    phoneE164: linked.phoneE164,
    contact: { connect: { id: linked.contactId } },
    jobTitle: normalizeJobTitle(input.jobTitle),
    ...linked.record,
    createdBy: { connect: { id: actorId } },
  };
}

// Defense-in-depth: strip any unexpected fields that the repo might leak (e.g.
// if a future change accidentally swaps the allowlisted select back to a full
// include). The repo already returns UserSummary; this enforces the contract.
function toUserSummary(u: UserSummary): UserView {
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
    registration: u.registration,
    contactAuthorization: toContactAuthorization(u),
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

// Matrícula e autorização da edição: só o que veio no corpo e mudou (A1/A2). A
// autorização igual à atual não regrava `RecordedAt`/`RecordedById` (D17).
function recordUpdateData(
  input: UserPatch,
  actorId: string,
  current: UserSummary,
): Prisma.UserUpdateInput {
  return {
    ...(input.registration !== undefined
      ? normalizeRegistration(input.registration)
      : {}),
    ...authorizationColumns(
      input.contactAuthorization,
      actorId,
      new Date(),
      current,
    ),
  };
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
    const [{ data, total }, authorizationCounts] = await Promise.all([
      this.repo.findMany(page, pageSize, filters),
      this.repo.countAuthorizationPending(),
    ]);
    return {
      data: data.map(toUserSummary),
      total,
      page,
      pageSize,
      authorizationCounts,
    };
  }

  async createUser(
    input: CreateUserInput,
    createdById: string,
  ): Promise<{ user: UserView; temporaryPassword: string }> {
    const phoneE164 = this.phones.normalize(input.phone);
    const existing = await this.repo.findByEmail(input.email);
    await this.assertCreatable(input, existing);
    await this.assertAssignableShift(input.shiftId);
    await this.assertAssignableLevel(input.levelId, null);
    const record = await this.personRecord(input, createdById);
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
      { phoneE164, contactId, record },
    );
    return { user: toUserSummary(created), temporaryPassword };
  }

  /**
   * Matrícula e autorização da criação, antes de qualquer gravação (inclusive a
   * do Contato): data futura e matrícula já usada (sem diferenciar maiúsculas)
   * recusam sem deixar rastro. A corrida que passa daqui estoura o P2002 da
   * chave no `createWithAudit` (`rethrowRegistrationConflict`).
   */
  private async personRecord(
    input: PersonRecordInput,
    actorId: string,
  ): Promise<PersonRecord> {
    const registration = normalizeRegistration(input.registration);
    const authorization = authorizationColumns(
      input.contactAuthorization,
      actorId,
      new Date(),
    );
    const { registrationKey } = registration;
    if (
      registrationKey &&
      (await this.repo.findIdByRegistrationKey(registrationKey))
    ) {
      throw registrationTaken();
    }
    return { ...registration, ...authorization };
  }

  /**
   * Grava a pessoa e a trilha da criação na mesma transação (GC1): `action` é
   * `user.invited` (com acesso) ou `user.person_created`. A trilha leva o
   * retrato da pessoa com telefone e e-mail mascarados (GC2), sem senha e sem
   * metadata com e-mail. Setor, turno e nível vão só em `values`: o
   * repositório abre a linha de vínculo com início = hoje (DV6/DV7). O motivo
   * (EX21) vai para a trilha; o convite passa `null`.
   */
  private createWithTrail(entry: {
    data: Prisma.UserCreateInput;
    action: 'user.invited' | 'user.person_created';
    actorId: string;
    values: AssignmentValues;
    reason: string | null;
  }): Promise<UserSummary> {
    const { data, action, actorId, values, reason } = entry;
    const assignment = { patch: values, today: todayIn(new Date()), actorId };
    return this.repo
      .createWithAudit(
        data,
        (tx, row, userId) =>
          this.audit.recordChange(tx, {
            action,
            entity: 'User',
            entityId: userId,
            category: 'PERSON',
            subjectUserId: userId,
            reason,
            changes: personAuditChanges(null, row),
            actorId,
          }),
        assignment,
      )
      .catch(rethrowPhoneConflict)
      .catch(rethrowRegistrationConflict);
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
    linked: LinkedRecord,
  ) {
    return this.createWithTrail({
      data: {
        email: input.email,
        name: input.name ?? null,
        role: input.role,
        password,
        mustChangePassword: true,
        phoneE164: linked.phoneE164,
        contact: { connect: { id: linked.contactId } },
        jobTitle: normalizeJobTitle(input.jobTitle),
        ...linked.record,
        createdBy: { connect: { id: createdById } },
      },
      action: 'user.invited',
      actorId: createdById,
      values: creationAssignment(input),
      reason: null,
    });
  }

  /**
   * Pessoa sem acesso (D1): sem credencial e sem senha temporária. O telefone
   * passa pelo mesmo caminho do convite (`UserPhoneService`): número de outra
   * pessoa é recusado e o de um Contato existente liga a pessoa a ele. `meta`
   * (opcional, EX21): `reason` vai para a trilha da criação (sem ele, nulo) e
   * `personId` (só a importação) é o id da pessoa criada.
   */
  async createPersonWithoutAccess(
    actorId: string,
    input: PersonWithoutAccessInput,
    meta?: PersonCreateMeta,
  ): Promise<UserView> {
    const phoneE164 = this.phones.normalize(input.phone);
    await this.assertActiveSectorIfGiven(input.sectorId);
    await this.assertAssignableShift(input.shiftId);
    await this.assertAssignableLevel(input.levelId, null);
    const record = await this.personRecord(input, actorId);
    await this.phones.assertAvailable(phoneE164);
    const contactId = await this.phones.resolveContactId(
      phoneE164,
      input.name.trim(),
    );
    const user = await this.createWithTrail({
      data: personWithoutAccessData(
        actorId,
        input,
        { phoneE164, contactId, record },
        meta?.personId,
      ),
      action: 'user.person_created',
      actorId,
      values: creationAssignment(input),
      reason: meta?.reason ?? null,
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
  ): Promise<{ user: UserView; temporaryPassword: string }> {
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
      .grantAccess(
        userId,
        {
          email,
          role: input.role,
          password,
          mustChangePassword: true,
          hasAccess: true,
        },
        this.grantTrail(userId, actorId, input.role),
      )
      .catch(rethrowEmailConflict);
    // Null = outro pedido deu acesso entre a leitura e o update.
    if (!granted) throw alreadyHasAccess();
    return { user: toUserSummary(granted), temporaryPassword };
  }

  /**
   * Trilha da concessão de acesso, no tx do update (GC1/GC2): só os campos que
   * mudaram (acesso, e-mail mascarado, papel se mudou); senha e hash nunca
   * entram. O papel concedido vai também em `metadata`, porque `changes` omite
   * o papel quando ele não muda (VIEWER → VIEWER).
   */
  private grantTrail(
    userId: string,
    actorId: string,
    role: Role,
  ): PersonUpdateTrail {
    return (tx, before, after) =>
      this.audit.recordChange(tx, {
        action: 'user.access_granted',
        entity: 'User',
        entityId: userId,
        category: 'PERSON',
        subjectUserId: userId,
        reason: null,
        changes: personAuditChanges(before, after),
        metadata: { role },
        actorId,
      });
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

  /**
   * Edita a pessoa e grava a trilha na mesma transação (GC1). O motivo (A4) é
   * cobrado por quem expõe a rota (`requireReason`); sem `meta` a trilha segue
   * sem motivo (chamadores do setor, que passam a informá-lo na T7). Quem pode
   * inativar ou alterar a autorização é decidido antes, por quem chama
   * (`/users` é só ADMIN; o setor usa `person-actions.policy`).
   */
  async updateUser(
    id: string,
    input: UserPatch,
    actorId: string,
    meta: PersonChangeMeta = { reason: null },
  ): Promise<void> {
    const user = await this.repo.findById(id);
    if (!user) throw new NotFoundError('User', id);

    this.assertSelfChangeAllowed(id, actorId, input);
    assertNameKept(user, input.name);
    await this.assertValidAssignment(user, input);
    await this.assertAssignableShift(input.shiftId);
    await this.assertRegistrationFree(id, input.registration);
    const changesIdentity = this.changesIdentity(input);
    const data = {
      ...this.toUpdateData(input, changesIdentity),
      ...recordUpdateData(input, actorId, user),
      ...(await this.phoneUpdate(user, input.phone, input.name)),
    };
    // Setor, turno e nível só pelo parâmetro `assignment` (DV5/DV15).
    const assignment = assignmentChange(input, actorId);

    // Transactional update with last-admin guard. Two concurrent demotions of
    // the only two admins would otherwise both pass a separate countAdmins
    // check; the serializable transaction prevents that race.
    const result = await this.lastAdminGuard(() =>
      this.repo.updateWithLastAdminGuard(
        id,
        data,
        this.updateTrail(id, actorId, meta),
        assignment,
      ),
    );
    if ('lastAdmin' in result) {
      throw new ForbiddenError(
        'Cannot demote the last admin',
        'user.last_admin',
      );
    }

    // A privilege change must not leave the old role cached in a live access
    // token (valid up to 15min): force re-login so the new role takes effect.
    if (changesIdentity) await this.refresh.revokeAllForUser(id);
  }

  /**
   * Trilha da edição, no tx do update (GC1/GC2/GC3): só os campos que mudaram,
   * com telefone e e-mail mascarados; nada mudou, nada grava. O autor é o
   * `actorId` explícito, não o do CLS (C2).
   */
  private updateTrail(
    id: string,
    actorId: string,
    meta: PersonChangeMeta,
  ): PersonUpdateTrail {
    return async (tx, before, after) => {
      const changes = personAuditChanges(before, after);
      if (changes.length === 0) return;
      await this.audit.recordChange(tx, {
        action: meta.action ?? personChangeAction(changes),
        entity: 'User',
        entityId: id,
        category: meta.category ?? 'PERSON',
        subjectUserId: id,
        reason: meta.reason,
        changes,
        actorId,
      });
    };
  }

  /** Matrícula já usada por outra pessoa → 422 antes de gravar; a própria não conflita (A1). */
  private async assertRegistrationFree(
    id: string,
    registration: string | null | undefined,
  ): Promise<void> {
    if (registration === undefined) return;
    const { registrationKey } = normalizeRegistration(registration);
    if (!registrationKey) return;
    const owner = await this.repo.findIdByRegistrationKey(registrationKey);
    if (owner && owner !== id) throw registrationTaken();
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
      ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      ...(input.jobTitle !== undefined
        ? { jobTitle: normalizeJobTitle(input.jobTitle) }
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
      // Tentativas esgotadas: P2034, ou P2002 da linha aberta de vínculo (DV7).
      // Mesmo 409 nos dois; o texto fala de administrador (o front lê o código).
      if (
        (error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2034') ||
        isOpenAssignmentConflict(error)
      ) {
        throw new ConflictError(
          'Concurrent administrator change, retry the request',
          'user.concurrent_admin_change',
        );
      }
      rethrowUniqueConflict(error);
    }
  }

  /**
   * Exclusão física: só quem `canDeletePerson` autoriza (decidido antes de ler
   * a pessoa), nunca a si mesmo, nunca o último ADMIN e só quem não deixou
   * histórico (A3/D7; com histórico, 409 e a saída é inativar). O repositório
   * confere o histórico, apaga e grava a trilha na mesma transação serializável.
   */
  async deleteUser(
    id: string,
    actorId: string,
    actorRole: Role,
  ): Promise<void> {
    if (!canDeletePerson({ id: actorId, role: actorRole })) {
      throw new ForbiddenError(
        'Só o administrador pode excluir uma pessoa.',
        'user.delete_forbidden',
      );
    }
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
      this.repo.deleteWithLastAdminGuard(id, this.deleteTrail(id, actorId)),
    );
    if ('lastAdmin' in result) {
      throw new ForbiddenError(
        'Cannot delete the last admin',
        'user.last_admin',
      );
    }
    if ('hasHistory' in result) throw hasHistory();

    // Burn any lingering refresh families so a deleted user's token can't keep
    // rotating until the 7-day family TTL lapses.
    await this.refresh.revokeAllForUser(id);
  }

  /**
   * Trilha da exclusão, no tx do delete (GC1/GC2): o retrato da pessoa como
   * estava (telefone e e-mail mascarados, sem senha) e nenhum "depois". O
   * evento fica depois que a pessoa some: `subjectUserId` não tem FK.
   */
  private deleteTrail(id: string, actorId: string): PersonDeleteTrail {
    return (tx, before) =>
      this.audit.recordChange(tx, {
        action: 'user.deleted',
        entity: 'User',
        entityId: id,
        category: 'PERSON',
        subjectUserId: id,
        reason: null,
        changes: personAuditChanges(before, null),
        actorId,
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
    await this.audit.log(
      'user.password_reset',
      'User',
      id,
      { resetBy: actorId },
      { subjectUserId: id },
    );

    return { temporaryPassword };
  }
}
