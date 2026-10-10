import { Injectable } from '@nestjs/common';
import { Prisma, type InternalCommunicationKind } from '@prisma/client';
import { PrismaService } from '../../shared/prisma/prisma.service';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../../shared/errors/domain.error';
import type {
  CreateInternalCommunication,
  InternalCommunicationListQuery,
  UpdateDemand,
} from '../../schemas/contracts/internal-communication.schema';
import {
  canChangeDemand,
  canCreateOrComment,
  canReadCommunication,
  type InternalActor,
} from './internal-communications.policy';

const actorSelect = {
  id: true,
  name: true,
  email: true,
  role: true,
  sectorId: true,
  isActive: true,
  sector: { select: { id: true, name: true, code: true } },
} satisfies Prisma.UserSelect;

const detailInclude = {
  originSector: { select: { id: true, name: true, code: true } },
  destinationSector: { select: { id: true, name: true, code: true } },
  recipients: {
    include: { sector: { select: { id: true, name: true, code: true } } },
  },
  author: { select: { id: true, name: true, email: true } },
  assignee: { select: { id: true, name: true, email: true, sectorId: true } },
  events: {
    orderBy: { createdAt: 'asc' as const },
    include: { actor: { select: { id: true, name: true, email: true } } },
  },
} satisfies Prisma.InternalCommunicationInclude;

type DetailRow = Prisma.InternalCommunicationGetPayload<{
  include: typeof detailInclude;
}>;

type PendingDemandEvent = Omit<
  Prisma.InternalEventCreateManyInput,
  'communicationId'
>;

type PendingDemandUpdate = {
  id: string;
  input: UpdateDemand;
  destinationSectorId: string;
  next: Prisma.InternalCommunicationUpdateManyMutationInput;
  events: PendingDemandEvent[];
};

@Injectable()
export class InternalCommunicationsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(userId: string, input: CreateInternalCommunication) {
    const actor = await this.actor(userId);
    this.assertWriter(actor);
    this.assertOrigin(actor, input.originSectorId);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const id = await this.createAtomically(actor, input);
        return this.detail(userId, id);
      } catch (error) {
        if (this.isUniqueClientRequestRace(error)) {
          return this.detail(
            userId,
            await this.repeatAfterCreateRace(actor, input),
          );
        }
        if (!this.isSerializationRace(error)) throw error;
        const winner = await this.findCreateRaceWinner(actor, input);
        if (winner) return this.detail(userId, winner);
        if (attempt === 2)
          throw new ConflictError(
            'Não foi possível criar a comunicação após novas tentativas.',
            'internal.create_retry',
          );
      }
    }
    throw new ConflictError('Não foi possível criar a comunicação.');
  }

  async detail(userId: string, id: string) {
    const actor = await this.actor(userId);
    const communication = await this.prisma.internalCommunication.findFirst({
      where: { id, ...this.scope(actor) },
      include: detailInclude,
    });
    if (!communication || !canReadCommunication(actor, communication)) {
      throw new NotFoundError('InternalCommunication', id);
    }
    const read = await this.prisma.internalRead.findUnique({
      where: { communicationId_userId: { communicationId: id, userId } },
    });
    return this.toDetail(
      communication,
      !read || read.readAt < communication.updatedAt,
    );
  }

  async list(
    userId: string,
    query: InternalCommunicationListQuery,
    recipientOnly = false,
  ) {
    const actor = await this.actor(userId);
    const where = this.listWhere(actor, query, recipientOnly);
    const [items, total] = await Promise.all([
      this.prisma.internalCommunication.findMany({
        where,
        include: detailInclude,
        orderBy: [{ dueDate: 'asc' }, { updatedAt: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.internalCommunication.count({ where }),
    ]);
    const readIds = await this.readIds(
      userId,
      items.map((item) => item.id),
    );
    return {
      items: items.map((item) =>
        this.toDetail(
          item,
          !readIds.has(item.id) || readIds.get(item.id)! < item.updatedAt,
        ),
      ),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  inbox(userId: string, query: InternalCommunicationListQuery) {
    return this.list(userId, query, true);
  }

  async comment(userId: string, id: string, message: string) {
    const actor = await this.actor(userId);
    const communication = await this.visible(actor, id);
    this.assertCommenter(actor, communication);
    await this.prisma.$transaction(async (tx) => {
      await tx.internalEvent.create({
        data: {
          communicationId: id,
          kind: 'COMMENTED',
          message,
          actorId: actor.id,
          actorSnapshot: this.actorSnapshot(actor),
        },
      });
      await tx.internalCommunication.update({
        where: { id },
        data: { updatedAt: new Date() },
      });
    });
    return this.detail(userId, id);
  }

  async updateDemand(userId: string, id: string, input: UpdateDemand) {
    const actor = await this.actor(userId);
    const current = await this.visible(actor, id);
    if (current.kind !== 'DEMAND')
      throw new ValidationError(
        'A comunicação não é uma demanda.',
        undefined,
        'internal.not_demand',
      );
    if (!canChangeDemand(actor, current))
      throw new NotFoundError('InternalCommunication', id);
    const next = this.nextDemand(current, input);
    const events = this.changeEvents(current, next, actor);
    const changed = await this.updateDemandAtomically({
      id,
      input,
      destinationSectorId: current.destinationSectorId,
      next,
      events,
    });
    if (!changed)
      throw new ConflictError(
        'A demanda foi alterada por outra pessoa.',
        'internal.version_conflict',
      );
    return this.detail(userId, id);
  }

  private async updateDemandAtomically(update: PendingDemandUpdate) {
    const { id, input, destinationSectorId, next, events } = update;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.prisma.$transaction(
          async (tx) => {
            await this.assertAssignee(
              input.assigneeId,
              destinationSectorId,
              tx,
              true,
            );
            const result = await tx.internalCommunication.updateMany({
              where: { id, version: input.expectedVersion },
              data: {
                ...next,
                version: { increment: 1 },
                updatedAt: new Date(),
              },
            });
            if (!result.count) return false;
            if (events.length)
              await tx.internalEvent.createMany({
                data: events.map((event) => ({
                  ...event,
                  communicationId: id,
                })),
              });
            return true;
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
      } catch (error) {
        if (!this.isSerializationRace(error)) throw error;
        if (attempt === 2)
          throw new ConflictError(
            'A demanda foi alterada por outra pessoa.',
            'internal.version_conflict',
          );
      }
    }
    throw new ConflictError('A demanda foi alterada por outra pessoa.');
  }

  async markRead(userId: string, id: string) {
    const actor = await this.actor(userId);
    await this.visible(actor, id);
    await this.prisma.internalRead.upsert({
      where: { communicationId_userId: { communicationId: id, userId } },
      create: { communicationId: id, userId },
      update: { readAt: new Date() },
    });
    return this.detail(userId, id);
  }

  async unreadCount(userId: string) {
    const actor = await this.actor(userId);
    const items = await this.prisma.internalCommunication.findMany({
      where: { ...this.scope(actor), OR: this.notificationScope(actor) },
      select: { id: true, updatedAt: true },
    });
    const reads = await this.readIds(
      userId,
      items.map((item) => item.id),
    );
    return {
      count: items.filter(
        (item) => !reads.has(item.id) || reads.get(item.id)! < item.updatedAt,
      ).length,
    };
  }

  async dashboard(userId: string) {
    const actor = await this.actor(userId);
    const demandWhere = this.dashboardDemandWhere(actor);
    const today = this.manausDate();
    const sectorId =
      actor.role === 'ADMIN' && !actor.sectorId ? undefined : actor.sectorId;
    const [
      needsAction,
      waitingOthers,
      unassigned,
      nearDeadline,
      completedThisWeek,
      priorities,
      recentUpdates,
    ] = await Promise.all([
      this.countNeedsAction(demandWhere, sectorId),
      this.countWaitingOthers(demandWhere, sectorId),
      this.countUnassigned(demandWhere),
      this.countNearDeadline(demandWhere, today),
      this.countCompletedThisWeek(demandWhere, today),
      this.dashboardPriorities(demandWhere),
      this.dashboardRecentUpdates(actor),
    ]);
    return {
      needsAction,
      nearDeadline,
      waitingOthers,
      unassigned,
      completedThisWeek,
      priorities: priorities.map((item) => this.toDetail(item, false)),
      recentUpdates,
      sector: actor.sectorId,
    };
  }

  private dashboardDemandWhere(actor: InternalActor) {
    return {
      ...this.scope(actor),
      kind: 'DEMAND',
    } satisfies Prisma.InternalCommunicationWhereInput;
  }

  private countNeedsAction(
    where: Prisma.InternalCommunicationWhereInput,
    sectorId: string | null | undefined,
  ) {
    return this.prisma.internalCommunication.count({
      where: {
        ...where,
        ...(sectorId ? { destinationSectorId: sectorId } : {}),
        status: { in: ['OPEN', 'IN_PROGRESS'] },
      },
    });
  }

  private countWaitingOthers(
    where: Prisma.InternalCommunicationWhereInput,
    sectorId: string | null | undefined,
  ) {
    return this.prisma.internalCommunication.count({
      where: {
        ...where,
        ...(sectorId
          ? { originSectorId: sectorId, destinationSectorId: { not: sectorId } }
          : {}),
        status: { not: 'COMPLETED' },
      },
    });
  }

  private countUnassigned(where: Prisma.InternalCommunicationWhereInput) {
    return this.prisma.internalCommunication.count({
      where: { ...where, assigneeId: null, status: { not: 'COMPLETED' } },
    });
  }

  private countNearDeadline(
    where: Prisma.InternalCommunicationWhereInput,
    today: string,
  ) {
    return this.prisma.internalCommunication.count({
      where: {
        ...where,
        dueDate: {
          gte: new Date(today),
          lte: new Date(this.addDays(today, 1)),
        },
        status: { not: 'COMPLETED' },
      },
    });
  }

  private countCompletedThisWeek(
    where: Prisma.InternalCommunicationWhereInput,
    today: string,
  ) {
    return this.prisma.internalCommunication.count({
      where: {
        ...where,
        status: 'COMPLETED',
        completedAt: { gte: this.manausStartOfDay(this.weekStart(today)) },
      },
    });
  }

  private dashboardPriorities(where: Prisma.InternalCommunicationWhereInput) {
    return this.prisma.internalCommunication.findMany({
      where: { ...where, status: { not: 'COMPLETED' } },
      include: detailInclude,
      orderBy: [
        { dueDate: 'asc' },
        { priority: 'desc' },
        { updatedAt: 'desc' },
      ],
      take: 5,
    });
  }

  private dashboardRecentUpdates(actor: InternalActor) {
    return this.prisma.internalEvent.findMany({
      where: { communication: this.scope(actor) },
      include: {
        communication: {
          select: { id: true, reference: true, subject: true, kind: true },
        },
        actor: { select: { id: true, name: true, email: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 8,
    });
  }

  private async createAtomically(
    actor: InternalActor,
    input: CreateInternalCommunication,
  ): Promise<string> {
    return this.prisma.$transaction(
      async (tx) => {
        const repeated = await tx.internalCommunication.findUnique({
          where: { clientRequestId: input.clientRequestId },
          include: {
            recipients: true,
            events: { where: { kind: 'CREATED' }, take: 1 },
          },
        });
        if (repeated)
          return this.assertIdempotentRepeat(repeated, actor, input);
        await this.assertSectors(tx, input);
        await this.assertAssignee(
          input.assigneeId,
          input.destinationSectorId,
          tx,
        );
        const pendingReference = `PENDING-${input.clientRequestId}`;
        const created = await tx.internalCommunication.create({
          data: this.createData(actor, input, pendingReference),
          select: { id: true, sequence: true },
        });
        await tx.internalCommunication.update({
          where: { id: created.id },
          data: { reference: this.reference(input.kind, created.sequence) },
        });
        return created.id;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  private async repeatAfterCreateRace(
    actor: InternalActor,
    input: CreateInternalCommunication,
  ): Promise<string> {
    const repeated = await this.prisma.internalCommunication.findUnique({
      where: { clientRequestId: input.clientRequestId },
      include: { events: { where: { kind: 'CREATED' }, take: 1 } },
    });
    if (!repeated) {
      throw new ConflictError(
        'Não foi possível repetir a criação.',
        'internal.create_retry',
      );
    }
    return this.assertIdempotentRepeat(repeated, actor, input);
  }

  private async findCreateRaceWinner(
    actor: InternalActor,
    input: CreateInternalCommunication,
  ): Promise<string | null> {
    const repeated = await this.prisma.internalCommunication.findUnique({
      where: { clientRequestId: input.clientRequestId },
      include: { events: { where: { kind: 'CREATED' }, take: 1 } },
    });
    return repeated
      ? this.assertIdempotentRepeat(repeated, actor, input)
      : null;
  }

  private isUniqueClientRequestRace(error: unknown): boolean {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    );
  }

  private isSerializationRace(error: unknown): boolean {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
    return (
      error.code === 'P2034' ||
      (error.code === 'P2010' && error.meta?.code === '40001')
    );
  }

  private async actor(userId: string): Promise<InternalActor> {
    const actor = await this.prisma.user.findUnique({
      where: { id: userId },
      select: actorSelect,
    });
    if (!actor || !actor.isActive)
      throw new ForbiddenError(
        'Usuário interno inativo.',
        'internal.user_inactive',
      );
    if (actor.role !== 'ADMIN' && !actor.sectorId)
      throw new ForbiddenError(
        'Usuário sem setor interno.',
        'internal.sector_required',
      );
    return actor;
  }

  private async visible(actor: InternalActor, id: string): Promise<DetailRow> {
    const communication = await this.prisma.internalCommunication.findFirst({
      where: { id, ...this.scope(actor) },
      include: detailInclude,
    });
    if (!communication || !canReadCommunication(actor, communication))
      throw new NotFoundError('InternalCommunication', id);
    return communication;
  }

  private scope(actor: InternalActor): Prisma.InternalCommunicationWhereInput {
    if (actor.role === 'ADMIN') return {};
    if (!actor.sectorId) return { id: '__none__' };
    return {
      OR: [
        { authorId: actor.id },
        { originSectorId: actor.sectorId },
        { destinationSectorId: actor.sectorId },
        { recipients: { some: { sectorId: actor.sectorId } } },
      ],
    };
  }

  private recipientScope(
    actor: InternalActor,
  ): Prisma.InternalCommunicationWhereInput {
    if (actor.role === 'ADMIN' && !actor.sectorId) return {};
    if (!actor.sectorId) return { id: '__none__' };
    return {
      OR: [
        { destinationSectorId: actor.sectorId },
        { recipients: { some: { sectorId: actor.sectorId } } },
      ],
    };
  }

  private listWhere(
    actor: InternalActor,
    query: InternalCommunicationListQuery,
    recipientOnly = false,
  ): Prisma.InternalCommunicationWhereInput {
    const scopedSector = actor.role === 'ADMIN' ? query.sectorId : undefined;
    return {
      AND: [
        recipientOnly ? this.recipientScope(actor) : this.scope(actor),
        {
          ...(query.kind ? { kind: query.kind } : {}),
          ...(query.status ? { status: query.status } : {}),
          ...(query.unassigned === true ? { assigneeId: null } : {}),
          ...(scopedSector
            ? {
                OR: [
                  { originSectorId: scopedSector },
                  { destinationSectorId: scopedSector },
                  { recipients: { some: { sectorId: scopedSector } } },
                ],
              }
            : {}),
          ...(query.q
            ? {
                OR: [
                  { subject: { contains: query.q, mode: 'insensitive' } },
                  { message: { contains: query.q, mode: 'insensitive' } },
                  { reference: { contains: query.q, mode: 'insensitive' } },
                ],
              }
            : {}),
        },
      ],
    };
  }

  private notificationScope(
    actor: InternalActor,
  ): Prisma.InternalCommunicationWhereInput[] {
    if (actor.role === 'ADMIN' && !actor.sectorId)
      return [
        { notifyTeam: true },
        { assigneeId: actor.id, notifyAssignee: true },
      ];
    if (!actor.sectorId)
      return [{ assigneeId: actor.id, notifyAssignee: true }];
    return [
      {
        notifyTeam: true,
        OR: [
          { destinationSectorId: actor.sectorId },
          { recipients: { some: { sectorId: actor.sectorId } } },
        ],
      },
      { assigneeId: actor.id, notifyAssignee: true },
    ];
  }

  private assertWriter(actor: InternalActor) {
    if (!canCreateOrComment(actor))
      throw new ForbiddenError(
        'Sem permissão para escrever.',
        'internal.read_only',
      );
  }
  private assertCommenter(actor: InternalActor, row: DetailRow) {
    if (!canReadCommunication(actor, row) || !canCreateOrComment(actor))
      throw new NotFoundError('InternalCommunication', row.id);
  }
  private assertOrigin(actor: InternalActor, originSectorId: string) {
    if (actor.role !== 'ADMIN' && actor.sectorId !== originSectorId)
      throw new ForbiddenError(
        'A origem deve ser seu setor.',
        'internal.origin_forbidden',
      );
  }

  private async assertSectors(
    tx: Prisma.TransactionClient,
    input: CreateInternalCommunication,
  ) {
    const ids = [
      input.originSectorId,
      input.destinationSectorId,
      ...input.ccSectorIds,
    ];
    const sectors = await tx.sector.findMany({
      where: { id: { in: ids }, isActive: true },
      select: { id: true },
    });
    if (sectors.length !== new Set(ids).size)
      throw new ValidationError(
        'Um ou mais setores estão inativos ou não existem.',
        undefined,
        'internal.invalid_sector',
      );
  }

  private async assertAssignee(
    assigneeId: string | null | undefined,
    sectorId: string,
    client: Prisma.TransactionClient | PrismaService = this.prisma,
    lock = false,
  ) {
    if (!assigneeId) return;
    if (lock)
      await client.$queryRaw(
        Prisma.sql`SELECT "id" FROM "User" WHERE "id" = ${assigneeId} FOR UPDATE`,
      );
    const assignee = await client.user.findFirst({
      where: {
        id: assigneeId,
        sectorId,
        isActive: true,
        role: { in: ['ADMIN', 'OPERATOR', 'SUPERVISOR'] },
      },
      select: { id: true },
    });
    if (!assignee)
      throw new ValidationError(
        'Responsável inválido para o setor de destino.',
        undefined,
        'internal.invalid_assignee',
      );
  }

  private createData(
    actor: InternalActor,
    input: CreateInternalCommunication,
    reference: string,
  ): Prisma.InternalCommunicationCreateInput {
    return {
      reference,
      clientRequestId: input.clientRequestId,
      kind: input.kind,
      subject: input.subject,
      message: input.message,
      author: { connect: { id: actor.id } },
      authorSnapshot: this.actorSnapshot(actor),
      originSector: { connect: { id: input.originSectorId } },
      destinationSector: { connect: { id: input.destinationSectorId } },
      recipients: {
        create: input.ccSectorIds.map((sectorId) => ({
          sector: { connect: { id: sectorId } },
        })),
      },
      ...(input.assigneeId
        ? { assignee: { connect: { id: input.assigneeId } } }
        : {}),
      priority: input.kind === 'DEMAND' ? (input.priority ?? 'NORMAL') : null,
      dueDate:
        input.kind === 'DEMAND' && input.dueDate
          ? new Date(input.dueDate)
          : null,
      status:
        input.kind === 'DEMAND'
          ? input.assigneeId
            ? 'IN_PROGRESS'
            : 'OPEN'
          : null,
      notifyTeam: input.notifyTeam,
      notifyAssignee: input.notifyAssignee,
      events: {
        create: {
          kind: 'CREATED',
          actorId: actor.id,
          actorSnapshot: this.createdSnapshot(actor, input),
        },
      },
    };
  }

  private assertIdempotentRepeat(
    row: {
      authorId: string | null;
      events: Array<{ actorSnapshot: Prisma.JsonValue | null }>;
      id: string;
    },
    actor: InternalActor,
    input: CreateInternalCommunication,
  ) {
    const same =
      row.authorId === actor.id &&
      this.fingerprintFromSnapshot(row.events[0]?.actorSnapshot) ===
        this.fingerprint(input);
    if (!same)
      throw new ConflictError(
        'A requisição já foi usada com outro conteúdo.',
        'internal.idempotency_conflict',
      );
    return row.id;
  }

  private nextDemand(current: DetailRow, input: UpdateDemand) {
    const assigneeId = this.nextAssignee(current, input);
    const status = this.nextStatus(current, input, assigneeId);
    return {
      assigneeId,
      status,
      priority: input.priority ?? current.priority,
      dueDate: this.nextDueDate(current, input),
      completedAt:
        status === 'COMPLETED' ? (current.completedAt ?? new Date()) : null,
    };
  }

  private nextAssignee(current: DetailRow, input: UpdateDemand) {
    return input.assigneeId === undefined
      ? current.assigneeId
      : input.assigneeId;
  }

  private nextStatus(
    current: DetailRow,
    input: UpdateDemand,
    assigneeId: string | null,
  ) {
    if (input.status) return input.status;
    if (input.assigneeId === undefined) return current.status;
    if (assigneeId) return 'IN_PROGRESS';
    return current.status === 'IN_PROGRESS' ? 'OPEN' : current.status;
  }

  private nextDueDate(current: DetailRow, input: UpdateDemand) {
    if (input.dueDate === undefined) return current.dueDate;
    return input.dueDate ? new Date(input.dueDate) : null;
  }

  private changeEvents(
    current: DetailRow,
    next: ReturnType<InternalCommunicationsService['nextDemand']>,
    actor: InternalActor,
  ) {
    const snapshot = this.actorSnapshot(actor);
    const events: PendingDemandEvent[] = [];
    if (current.status !== next.status)
      events.push({
        kind: 'STATUS_CHANGED',
        actorId: actor.id,
        actorSnapshot: snapshot,
      });
    if (current.assigneeId !== next.assigneeId)
      events.push({
        kind: next.assigneeId ? 'ASSIGNED' : 'UNASSIGNED',
        actorId: actor.id,
        actorSnapshot: snapshot,
      });
    if (current.priority !== next.priority)
      events.push({
        kind: 'PRIORITY_CHANGED',
        actorId: actor.id,
        actorSnapshot: snapshot,
      });
    if (current.dueDate?.getTime() !== next.dueDate?.getTime())
      events.push({
        kind: 'DUE_DATE_CHANGED',
        actorId: actor.id,
        actorSnapshot: snapshot,
      });
    return events;
  }

  private actorSnapshot(actor: InternalActor): Prisma.InputJsonValue {
    return {
      id: actor.id,
      name: actor.name,
      email: actor.email,
      role: actor.role,
      sectorId: actor.sectorId,
      sector: actor.sector,
    };
  }
  private createdSnapshot(
    actor: InternalActor,
    input: CreateInternalCommunication,
  ): Prisma.InputJsonValue {
    return {
      author: this.actorSnapshot(actor),
      requestFingerprint: this.fingerprint(input),
    };
  }
  private fingerprint(input: CreateInternalCommunication) {
    return JSON.stringify({
      ...input,
      priority: input.kind === 'DEMAND' ? (input.priority ?? 'NORMAL') : null,
      dueDate: input.kind === 'DEMAND' ? (input.dueDate ?? null) : null,
      assigneeId: input.kind === 'DEMAND' ? (input.assigneeId ?? null) : null,
      ccSectorIds: [...input.ccSectorIds].sort(),
    });
  }
  private fingerprintFromSnapshot(snapshot: Prisma.JsonValue | null) {
    return snapshot &&
      typeof snapshot === 'object' &&
      !Array.isArray(snapshot) &&
      typeof snapshot.requestFingerprint === 'string'
      ? snapshot.requestFingerprint
      : null;
  }
  private reference(kind: InternalCommunicationKind, sequence: number) {
    return `${kind === 'DEMAND' ? 'DM' : 'CM'}-${String(sequence).padStart(6, '0')}`;
  }
  private async readIds(userId: string, ids: string[]) {
    const reads = ids.length
      ? await this.prisma.internalRead.findMany({
          where: { userId, communicationId: { in: ids } },
          select: { communicationId: true, readAt: true },
        })
      : [];
    return new Map(reads.map((read) => [read.communicationId, read.readAt]));
  }
  private toDetail(row: DetailRow, isUnread: boolean) {
    return {
      id: row.id,
      reference: row.reference,
      kind: row.kind,
      subject: row.subject,
      message: row.message,
      originSector: row.originSector,
      destinationSector: row.destinationSector,
      ccSectors: row.recipients.map((item) => item.sector),
      author: this.safePerson(row.author ?? row.authorSnapshot),
      assignee: row.assignee,
      priority: row.priority,
      dueDate: row.dueDate?.toISOString().slice(0, 10) ?? null,
      status: row.status,
      version: row.version,
      notifyTeam: row.notifyTeam,
      notifyAssignee: row.notifyAssignee,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      completedAt: row.completedAt,
      isUnread,
      events: row.events.map((event) => ({
        id: event.id,
        kind: event.kind,
        message: event.message,
        author: this.safePerson(
          event.actor ?? this.eventSnapshotAuthor(event.actorSnapshot),
        ),
        createdAt: event.createdAt,
      })),
    };
  }

  private eventSnapshotAuthor(snapshot: Prisma.JsonValue | null): unknown {
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot))
      return snapshot;
    return 'author' in snapshot ? snapshot.author : snapshot;
  }

  private safePerson(
    value: unknown,
  ): { id: string; name: string | null; email: string | null } | null {
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      !('id' in value) ||
      typeof value.id !== 'string'
    )
      return null;
    return {
      id: value.id,
      name:
        'name' in value && typeof value.name === 'string' ? value.name : null,
      email:
        'email' in value && typeof value.email === 'string'
          ? value.email
          : null,
    };
  }
  private manausDate() {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Manaus',
    }).format(new Date());
  }
  private addDays(date: string, days: number) {
    const value = new Date(`${date}T00:00:00Z`);
    value.setUTCDate(value.getUTCDate() + days);
    return value.toISOString().slice(0, 10);
  }
  private weekStart(today: string) {
    const date = new Date(`${today}T00:00:00Z`);
    const offset = (date.getUTCDay() + 6) % 7;
    return this.addDays(today, -offset);
  }
  private manausStartOfDay(date: string) {
    return new Date(`${date}T04:00:00.000Z`);
  }
}
