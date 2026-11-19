import { Injectable } from '@nestjs/common';
import { Prisma, type Role, type User } from '@prisma/client';
import { PrismaService } from '../../shared/prisma/prisma.service';
import crypto from 'crypto';
import { personAuditSelect, type PersonAuditRow } from './person-audit';
import { todayIn, type CivilDate } from '../staff-schedule/civil-date';
import type { AssignmentPatch } from './assignment-timeline';
import { isOpenAssignmentConflict, writeAssignment } from './assignment-writer';
import { personHasHistory } from './person-history';
import {
  foldAuthorizationCounts,
  userListWhere,
  type UserListFilters,
} from './user-list-where';

export type { UserListFilters };

// Allowlist of fields safe to expose via the API. Crucially does NOT include
// `password` — the argon2 hash must never leave the backend, even logged.
const USER_SUMMARY_SELECT = {
  id: true,
  email: true,
  hasAccess: true,
  name: true,
  role: true,
  sectorId: true,
  sector: { select: { id: true, name: true, code: true, isActive: true } },
  isActive: true,
  sessionVersion: true,
  mustChangePassword: true,
  lastLoginAt: true,
  // Telefone sim; `contactId` NÃO entra no summary nem no contrato público.
  phoneE164: true,
  shiftId: true,
  jobTitle: true,
  // Ficha: matrícula (a chave em minúsculas não sai) e a autorização de contato.
  // `authorizationRecordedById` também fica de fora.
  registration: true,
  contactAuthorization: true,
  authorizationSource: true,
  authorizationNote: true,
  authorizationDate: true,
  authorizationRecordedAt: true,
  levelId: true,
  level: { select: { id: true, name: true, isActive: true } },
  createdAt: true,
  updatedAt: true,
  createdById: true,
  createdBy: { select: { email: true } },
} satisfies Prisma.UserSelect;

export type UserSummary = Prisma.UserGetPayload<{
  select: typeof USER_SUMMARY_SELECT;
}>;

export type UserListResult = {
  data: UserSummary[];
  total: number;
};

/**
 * Trilha da criação (GC1): roda no tx da pessoa, com o retrato dela lido nesse
 * tx e o id. Se lançar, a pessoa não fica criada.
 */
export type PersonCreateTrail = (
  tx: Prisma.TransactionClient,
  row: PersonAuditRow,
  userId: string,
) => Promise<void>;

/**
 * Trilha da edição (GC1): roda no tx do update, com o retrato de antes e o de
 * depois lidos nele. Se lançar, a edição não fica.
 */
export type PersonUpdateTrail = (
  tx: Prisma.TransactionClient,
  before: PersonAuditRow,
  after: PersonAuditRow,
) => Promise<void>;

/**
 * Trilha da exclusão (GC1): roda no tx do delete, com o retrato da pessoa lido
 * nele antes de apagar. Se lançar, a pessoa não é excluída.
 */
export type PersonDeleteTrail = (
  tx: Prisma.TransactionClient,
  before: PersonAuditRow,
) => Promise<void>;

/**
 * Troca de setor, turno ou nível (CV3): só por aqui, nunca em `data` (DV15).
 * `today` vem do serviço (`todayIn`, DV7); `actorId` vira `recordedById`.
 */
export type AssignmentChange = {
  patch: AssignmentPatch;
  today: CivilDate;
  actorId: string | null;
};

// Chaves de vínculo que `data` não pode trazer (DV15(b)): relação e coluna.
const ASSIGNMENT_KEYS = [
  'sector',
  'sectorId',
  'workShift',
  'shiftId',
  'level',
  'levelId',
  'assignments',
] as const;

/** Vínculo em `data` fura a função única: recusa antes de abrir o tx. */
function refuseAssignmentInData(data: object): Promise<never> | null {
  const fields = data as Record<string, unknown>;
  return ASSIGNMENT_KEYS.some((key) => fields[key] !== undefined)
    ? Promise.reject(new Error('vínculo só por writeAssignment'))
    : null;
}

/** Credencial de quem ganha acesso (D1): tudo num único update. */
export type AccessGrantData = {
  email: string;
  role: Role;
  password: string;
  mustChangePassword: true;
  hasAccess: true;
};

@Injectable()
export class UsersRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Generate a 12-char URL-safe temp password via crypto.randomBytes. */
  static generateTempPassword(): string {
    return crypto.randomBytes(9).toString('base64url').slice(0, 12);
  }

  findMany(
    page: number,
    pageSize: number,
    filters: UserListFilters = {},
  ): Promise<UserListResult> {
    const skip = (page - 1) * pageSize;
    const where = userListWhere(filters);
    return Promise.all([
      this.prisma.user.findMany({
        where,
        skip,
        take: pageSize,
        orderBy: { createdAt: 'desc' },
        select: USER_SUMMARY_SELECT,
      }),
      this.prisma.user.count({ where }),
    ]).then(([data, total]) => ({ data, total }));
  }

  /**
   * Contadores da lista (D9): só pessoas ativas, na base inteira (não seguem
   * a página nem os filtros), numa única consulta agregada.
   */
  countAuthorizationPending(): Promise<{
    unverified: number;
    notAuthorized: number;
  }> {
    return this.prisma.user
      .groupBy({
        by: ['contactAuthorization', 'authorizationSource'],
        where: { isActive: true },
        _count: { _all: true },
      })
      .then(foldAuthorizationCounts);
  }

  findById(id: string): Promise<UserSummary | null> {
    return this.prisma.user.findUnique({
      where: { id },
      select: USER_SUMMARY_SELECT,
    });
  }

  findByEmail(email: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { email } });
  }

  /** Quem já tem a matrícula (chave em minúsculas), para a pré-checagem da criação. */
  findIdByRegistrationKey(key: string): Promise<string | null> {
    return this.prisma.user
      .findUnique({ where: { registrationKey: key }, select: { id: true } })
      .then((user) => user?.id ?? null);
  }

  /**
   * Cria a pessoa, abre a linha de vínculo (`writeAssignment`, origem CREATE:
   * sempre abre, mesmo com os três em branco) e grava a trilha na mesma
   * transação (GC1): se a trilha lançar, nem pessoa nem linha ficam. O retrato
   * da trilha e o resumo devolvido são lidos depois da função. Sem
   * `assignment`: nada atribuído, hoje em Manaus, sem autor. Matrícula
   * repetida estoura P2002 em `registrationKey`. Transação padrão: o id é novo.
   */
  createWithAudit(
    data: Prisma.UserCreateInput,
    audit: PersonCreateTrail,
    assignment?: AssignmentChange,
  ): Promise<UserSummary> {
    const refused = refuseAssignmentInData(data);
    if (refused) return refused;
    const change = assignment ?? {
      patch: {},
      today: todayIn(new Date()),
      actorId: null,
    };
    return this.prisma.$transaction(async (tx) => {
      const { id } = await tx.user.create({ data, select: { id: true } });
      await writeAssignment(tx, { userId: id, ...change, origin: 'CREATE' });
      const row = await tx.user.findUniqueOrThrow({
        where: { id },
        select: personAuditSelect,
      });
      await audit(tx, row, id);
      return tx.user.findUniqueOrThrow({
        where: { id },
        select: USER_SUMMARY_SELECT,
      });
    });
  }

  /**
   * Dá acesso a quem não tem: um único UPDATE condicionado a `hasAccess =
   * false`, com a trilha (GC1) no mesmo tx, que recebe o retrato de antes e o
   * de depois. Serializable: dois pedidos concorrentes para a mesma pessoa, o
   * segundo é refeito, relê a linha já com acesso e não casa → null. E-mail de
   * outro usuário estoura o @unique (P2002), tratado no serviço.
   */
  grantAccess(
    id: string,
    data: AccessGrantData,
    audit: PersonUpdateTrail,
  ): Promise<UserSummary | null> {
    return this.runSerializable(async (tx) => {
      const before = await tx.user.findUnique({
        where: { id },
        select: personAuditSelect,
      });
      if (!before) return null;
      const { count } = await tx.user.updateMany({
        where: { id, hasAccess: false },
        data,
      });
      if (count === 0) return null;
      const after = await tx.user.findUniqueOrThrow({
        where: { id },
        select: personAuditSelect,
      });
      await audit(tx, before, after);
      return tx.user.findUniqueOrThrow({
        where: { id },
        select: USER_SUMMARY_SELECT,
      });
    });
  }

  /** Id do usuário dono de qualquer uma das grafias do número (ou null). */
  async findIdByPhoneVariants(variants: string[]): Promise<string | null> {
    const row = await this.prisma.user.findFirst({
      where: { phoneE164: { in: variants } },
      select: { id: true },
    });
    return row?.id ?? null;
  }

  /** Só para o PATCH com o mesmo número: o contato ainda está ligado? */
  async findContactId(id: string): Promise<string | null> {
    const row = await this.prisma.user.findUnique({
      where: { id },
      select: { contactId: true },
    });
    return row?.contactId ?? null;
  }

  /**
   * Exclui a pessoa, só se ela não deixou histórico (A3/D7) e se não for o
   * último ADMIN ativo. A checagem de histórico, a contagem, o delete e a
   * trilha (GC1) rodam na mesma transação Serializable: dois pedidos contra
   * dois ADMINs distintos veem o mesmo conjunto e só um passa, e nada ganha
   * histórico entre conferir e apagar. A trilha recebe o retrato lido no tx;
   * se lançar, a pessoa continua. `subjectUserId` do evento não tem FK: ele
   * sobrevive à exclusão.
   *
   * Devolve `{ deleted }` (o retrato apagado), `{ lastAdmin }` ou
   * `{ hasHistory }`; quem chama transforma os dois últimos em erro. Lança
   * quando a pessoa não existe (o serviço já tratou o 404 antes).
   */
  deleteWithLastAdminGuard(
    id: string,
    audit: PersonDeleteTrail,
  ): Promise<
    { deleted: PersonAuditRow } | { lastAdmin: true } | { hasHistory: true }
  > {
    return this.runSerializable(async (tx) => {
      const before = await tx.user.findUnique({
        where: { id },
        select: personAuditSelect,
      });
      if (!before) throw new Error('USER_NOT_FOUND');
      if (before.role === 'ADMIN' && before.isActive) {
        const adminCount = await tx.user.count({
          where: { role: 'ADMIN', isActive: true },
        });
        if (adminCount <= 1) return { lastAdmin: true as const };
      }
      if (await personHasHistory(tx, id)) return { hasHistory: true as const };
      await tx.user.delete({ where: { id } });
      await audit(tx, before);
      return { deleted: before };
    });
  }

  /**
   * Update a user with the same last-admin guard semantics as
   * deleteWithLastAdminGuard: if `data.role` would demote the last admin, the
   * transaction rejects. Other field-only updates skip the count check.
   *
   * Setor, turno e nível só chegam por `assignment` (DV15): `writeAssignment`
   * (origem CHANGE) roda no mesmo tx, depois do update e antes de reler o
   * retrato de depois. A trilha (GC1) roda no mesmo tx, com o retrato de antes
   * lido nele e o de depois relido após a função: se lançar, nem edição nem
   * linha nem espelho ficam. Numa nova tentativa por conflito (P2034, ou P2002
   * no único parcial da linha aberta) o tx anterior já foi desfeito, então a
   * trilha é refeita sem duplicar evento e a linha aberta é relida.
   */
  updateWithLastAdminGuard(
    id: string,
    data: Prisma.UserUpdateInput,
    audit?: PersonUpdateTrail,
    assignment?: AssignmentChange,
  ): Promise<{ updated: PersonAuditRow } | { lastAdmin: true }> {
    const refused = refuseAssignmentInData(data);
    if (refused) return refused;
    return this.runSerializable(async (tx) => {
      const before = await tx.user.findUnique({
        where: { id },
        select: personAuditSelect,
      });
      if (!before) throw new Error('USER_NOT_FOUND');
      if (await this.dropsLastAdmin(tx, before, data))
        return { lastAdmin: true as const };
      await tx.user.update({ where: { id }, data, select: { id: true } });
      if (assignment)
        await writeAssignment(tx, {
          userId: id,
          ...assignment,
          origin: 'CHANGE',
        });
      const updated = await tx.user.findUniqueOrThrow({
        where: { id },
        select: personAuditSelect,
      });
      await audit?.(tx, before, updated);
      return { updated };
    });
  }

  /** A edição tiraria o último ADMIN ativo (papel ou situação)? */
  private async dropsLastAdmin(
    tx: Prisma.TransactionClient,
    before: PersonAuditRow,
    data: Prisma.UserUpdateInput,
  ): Promise<boolean> {
    const nextRole = typeof data.role === 'string' ? data.role : before.role;
    const nextActive =
      typeof data.isActive === 'boolean' ? data.isActive : before.isActive;
    if (
      before.role !== 'ADMIN' ||
      !before.isActive ||
      (nextRole === 'ADMIN' && nextActive)
    )
      return false;
    const adminCount = await tx.user.count({
      where: { role: 'ADMIN', isActive: true },
    });
    return adminCount <= 1;
  }

  resetPassword(id: string, passwordHash: string): Promise<void> {
    return this.prisma.user
      .update({
        where: { id },
        data: {
          password: passwordHash,
          mustChangePassword: true,
          sessionVersion: { increment: 1 },
        },
      })
      .then(() => undefined);
  }

  findActiveSector(id: string) {
    return this.prisma.sector.findFirst({ where: { id, isActive: true } });
  }

  /** Turno para atribuir a um usuário; o serviço recusa inexistente ou inativo. */
  findShiftForAssignment(
    id: string,
  ): Promise<{ id: string; isActive: boolean } | null> {
    return this.prisma.shift.findUnique({
      where: { id },
      select: { id: true, isActive: true },
    });
  }

  /** Nível para atribuir a uma pessoa; o serviço recusa inexistente ou inativo. */
  findLevelForAssignment(
    id: string,
  ): Promise<{ id: string; isActive: boolean } | null> {
    return this.prisma.staffLevel.findUnique({
      where: { id },
      select: { id: true, isActive: true },
    });
  }

  private async runSerializable<T>(
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.prisma.$transaction(operation, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
      } catch (error) {
        if (!this.isSerializationFailure(error)) throw error;
        lastError = error;
      }
    }
    throw lastError;
  }

  /** P2034, ou inserção concorrente de linha aberta de vínculo (DV7). */
  private isSerializationFailure(error: unknown): boolean {
    return (
      (error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2034') ||
      isOpenAssignmentConflict(error)
    );
  }
}
