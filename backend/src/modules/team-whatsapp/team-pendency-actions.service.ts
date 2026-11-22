import { Injectable } from '@nestjs/common';
import type {
  AssumePendencyInput,
  ClosePendencyInput,
  HandlerState,
  PendencyNoteInput,
  ReopenPendencyInput,
  TransferPendencyInput,
} from '../../schemas/contracts/team-pendency.schema';
import { AuditService } from '../../shared/audit/audit.service';
import {
  hasPermission,
  permissionDenied,
} from '../../shared/authz/permissions';
import { nameView } from '../../shared/authz/phone-visibility';
import {
  NotFoundError,
  type DomainError,
} from '../../shared/errors/domain.error';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { findTeamActor } from './team-actor.query';
import { ackExists } from './team-alert.errors';
import { findTeamActors, handlerStatesFor } from './team-actors.query';
import {
  notHandler,
  pendencyChanged,
  pendencyNotFound,
  pendencyTaken,
  type HandlerRef,
} from './team-pendency.errors';
import {
  assumeKind,
  canHandlePendency,
  pendencyDueAt,
  requiresHandler,
  type AssumeKind,
  type LockedPendency,
  type PendencyConflict,
  type PendencyScopeFacts,
} from './team-pendency.rules';
import { requireVisiblePendency } from './team-pendency-scope.repository';
import {
  runPendencyTransition,
  type PendencyOutcome,
  type PendencyTransition,
} from './team-pendency-write.repository';
import { seesFullPhone } from './team-whatsapp.name-view';
import type { TeamActor } from './team-whatsapp.policy';

type AssumePlan = {
  recipientId: string;
  actor: TeamActor;
  now: Date;
  kind: AssumeKind;
  expectedHandlerId: string | null;
  expectedState: HandlerState | null;
  note: string | undefined;
};

/**
 * Transição do "Assumir" (DK11). Os três tipos esperam a pendência aberta e o
 * responsável que a tela mostrava; só o `noop` (eu já sou o responsável) não
 * grava nada: passa pela linha travada só para conferir que o estado ainda é o
 * mostrado (`patch` e `note` nulos, DK10.4), e a observação é ignorada. O prazo
 * recomeça em `now` (K2-8) e a observação vira anotação `ASSUME`; a trilha leva
 * só o `kind`, nunca o texto (DK16).
 */
function assumeTransition(plan: AssumePlan): PendencyTransition {
  const { recipientId, actor, now, kind, expectedHandlerId } = plan;
  const base = {
    recipientId,
    actorId: actor.id,
    now,
    action: 'team_whatsapp.pendency_assume' as const,
    kind,
    expect: { handlerId: expectedHandlerId, closed: false as const },
  };
  if (kind === 'noop') {
    const state = plan.expectedState;
    return {
      ...base,
      patch: null,
      note: null,
      handlerState: { before: state, after: state },
    };
  }
  return {
    ...base,
    patch: {
      handlerId: actor.id,
      assignedAt: now,
      dueAt: pendencyDueAt(now),
    },
    note: plan.note ? { kind: 'ASSUME', text: plan.note } : null,
    handlerState: { before: plan.expectedState, after: 'active' },
  };
}

/**
 * Recusa de estado do "Assumir" (DK11): outro assumiu antes só vira
 * `pendency_taken` em `assume` com responsável atual; ciência, encerramento,
 * transferência no meio e os demais casos são `pendency_changed`.
 */
function assumeConflict(
  kind: AssumeKind,
  conflict: PendencyConflict,
  current: HandlerRef | null,
): DomainError {
  if (conflict === 'missing') return pendencyNotFound();
  const takenByOther =
    conflict === 'handler_changed' && kind === 'assume' && current !== null;
  return takenByOther ? pendencyTaken(current) : pendencyChanged(current);
}

type TransferPlan = {
  recipientId: string;
  actor: TeamActor;
  now: Date;
  toUserId: string;
  expectedHandlerId: string | null;
  expectedState: HandlerState | null;
};

/**
 * Transição do "Transferir" (DK12): espera a pendência aberta e o responsável
 * que a tela mostrava, sem anotação. O prazo recomeça em `now` e o destino, já
 * validado, nasce `active`. Transferir para o próprio responsável mostrado é o
 * "nada a fazer": passa pela linha travada só para conferir o estado (`patch` e
 * `note` nulos, DK10.4) e não grava nada.
 */
function transferTransition(plan: TransferPlan): PendencyTransition {
  const { recipientId, actor, now, toUserId, expectedHandlerId } = plan;
  const base = {
    recipientId,
    actorId: actor.id,
    now,
    action: 'team_whatsapp.pendency_transfer' as const,
    expect: { handlerId: expectedHandlerId, closed: false as const },
    note: null,
  };
  const state = plan.expectedState;
  if (toUserId === expectedHandlerId) {
    return {
      ...base,
      patch: null,
      handlerState: { before: state, after: state },
    };
  }
  return {
    ...base,
    patch: { handlerId: toUserId, assignedAt: now, dueAt: pendencyDueAt(now) },
    handlerState: { before: state, after: 'active' },
  };
}

type NotePlan = {
  recipientId: string;
  actor: TeamActor;
  now: Date;
  expectedHandlerId: string | null;
  expectedState: HandlerState | null;
  text: string;
};

/**
 * Transição do "Registrar contato" (DK13): só a anotação `CONTACT` (`patch`
 * nulo: situação e prazo não mudam, então o estado do responsável é o mesmo
 * antes e depois). Só olha o responsável: ciência e encerramento não impedem o
 * contato (`closed: 'any'`, `ignoreAck`). A trilha leva o `noteId`, nunca o texto.
 */
function noteTransition(plan: NotePlan): PendencyTransition {
  const { recipientId, actor, now, expectedHandlerId, expectedState } = plan;
  return {
    recipientId,
    actorId: actor.id,
    now,
    action: 'team_whatsapp.pendency_note',
    kind: 'CONTACT',
    expect: { handlerId: expectedHandlerId, closed: 'any', ignoreAck: true },
    patch: null,
    note: { kind: 'CONTACT', text: plan.text },
    handlerState: { before: expectedState, after: expectedState },
  };
}

/** Recusa de estado de Transferir e Registrar contato: tudo é `pendency_changed` (DK12, DK13). */
function changedConflict(
  conflict: PendencyConflict,
  current: HandlerRef | null,
): DomainError {
  return conflict === 'missing' ? pendencyNotFound() : pendencyChanged(current);
}

type ReopenPlan = {
  recipientId: string;
  actor: TeamActor;
  now: Date;
  expectedHandlerId: string | null;
  expectedState: HandlerState | null;
};

type ClosePlan = ReopenPlan & { reason: string };

/**
 * Transição do "Encerrar" (DK14): espera a pendência aberta, sem ciência, e o
 * responsável que a tela mostrava. Grava o encerramento (`closedAt`,
 * `closedById`, `closeReason`) e, também, a anotação `CLOSE` com o motivo, que
 * sobrevive à reabertura (DK2). Responsável e prazo ficam, então o estado do
 * responsável é o mesmo antes e depois. Não cria ciência (`ackAt` nem é
 * tocado); a trilha leva só ids e situações, nunca o motivo (DK16).
 */
function closeTransition(plan: ClosePlan): PendencyTransition {
  const { recipientId, actor, now, expectedHandlerId, expectedState } = plan;
  return {
    recipientId,
    actorId: actor.id,
    now,
    action: 'team_whatsapp.pendency_close',
    expect: { handlerId: expectedHandlerId, closed: false },
    patch: { closedAt: now, closedById: actor.id, closeReason: plan.reason },
    note: { kind: 'CLOSE', text: plan.reason },
    handlerState: { before: expectedState, after: expectedState },
  };
}

/**
 * Transição do "Reabrir" (DK14): espera a pendência encerrada, sem ciência, e o
 * responsável que a tela mostrava. Limpa as três colunas de encerramento (a
 * anotação `CLOSE` fica). Com responsável, o prazo recomeça em `now + 60 min`;
 * sem responsável (encerrada pelo ADMIN), o prazo é nulo e a pendência volta a
 * "Sem responsável". Quem o responsável é não muda.
 */
function reopenTransition(plan: ReopenPlan): PendencyTransition {
  const { recipientId, actor, now, expectedHandlerId, expectedState } = plan;
  return {
    recipientId,
    actorId: actor.id,
    now,
    action: 'team_whatsapp.pendency_reopen',
    expect: { handlerId: expectedHandlerId, closed: true },
    patch: {
      closedAt: null,
      closedById: null,
      closeReason: null,
      dueAt: expectedHandlerId === null ? null : pendencyDueAt(now),
    },
    note: null,
    handlerState: { before: expectedState, after: expectedState },
  };
}

/** Recusa de estado do Encerrar (DK14): ciência chegou antes é 422 `ack_exists`; o resto é `pendency_changed`. */
function closeConflict(
  conflict: PendencyConflict,
  current: HandlerRef | null,
): DomainError {
  return conflict === 'acked'
    ? ackExists()
    : changedConflict(conflict, current);
}

/**
 * GK5: o ator relido do banco é quem vira responsável ou grava a anotação, e
 * precisa da chave agora (o guard só olhou o papel do token): sem ela,
 * `auth.permission_denied`, como o guard.
 */
function requireSendPermission(actor: TeamActor): void {
  if (!hasPermission(actor, 'equipe.enviar')) {
    throw permissionDenied('equipe.enviar');
  }
}

/**
 * Ações de escrita sobre a pendência da equipe (Lote K2). Recusas, nesta ordem
 * (DK9): 403 de quem não é remetente → 404 fora do alcance → 403 da chave
 * `equipe.enviar` relida → 403 `not_handler` (Transferir, Registrar contato,
 * Encerrar e Reabrir) → 404 do destino (Transferir) → 409 de estado (ou 422
 * `ack_exists` no Encerrar com ciência). Toda escrita passa por
 * `runPendencyTransition` (trava, conferência, gravação e trilha na mesma
 * transação, GK3); nada aqui grava colunas de pendência.
 */
@Injectable()
export class TeamPendencyActionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Assumir e Assumir de outro (K2-7, DK11): quem vê a pendência e tem
   * `equipe.enviar` vira o responsável, com prazo de 60 min. O estado do
   * responsável mostrado é lido antes da trava só para escolher o tipo; a
   * conferência que decide é a da linha travada.
   */
  async assume(
    actorId: string,
    id: string,
    input: AssumePendencyInput,
    now: Date,
  ): Promise<void> {
    const { actor, facts } = await this.visibleWriter(actorId, id);
    const expectedHandlerId = input.expectedHandlerId;
    const expectedState = await this.shownState(facts, expectedHandlerId);
    const kind = assumeKind(actor.id, expectedHandlerId, expectedState);
    const plan = {
      recipientId: id,
      actor,
      now,
      kind,
      expectedHandlerId,
      expectedState,
      note: input.note,
    };
    const outcome = await runPendencyTransition(
      this.prisma,
      this.audit,
      assumeTransition(plan),
    );
    if (!outcome.ok) {
      throw await this.refusal(actor, outcome, (conflict, current) =>
        assumeConflict(kind, conflict, current),
      );
    }
  }

  /**
   * Transferir (K2-7, DK12): o responsável mostrado, ou o ADMIN, passa a
   * pendência a outro usuário que a possa tratar (`canHandlePendency`: ativo,
   * com acesso, remetente, `equipe.enviar` e que a veja); senão 404
   * `user.not_found`, como usuário inexistente, sem dizer qual regra falhou.
   */
  async transfer(
    actorId: string,
    id: string,
    input: TransferPendencyInput,
    now: Date,
  ): Promise<void> {
    const { expectedHandlerId, toUserId } = input;
    const { actor, facts } = await this.visibleHandler(
      actorId,
      id,
      expectedHandlerId,
    );
    const target = await findTeamActor(this.prisma, toUserId);
    if (!canHandlePendency(target, facts)) {
      throw new NotFoundError('User', toUserId);
    }
    const expectedState = await this.shownState(facts, expectedHandlerId);
    const outcome = await runPendencyTransition(
      this.prisma,
      this.audit,
      transferTransition({
        recipientId: id,
        actor,
        now,
        toUserId,
        expectedHandlerId,
        expectedState,
      }),
    );
    if (!outcome.ok) {
      throw await this.refusal(actor, outcome, changedConflict);
    }
  }

  /**
   * Registrar contato (K2-7, DK13): o responsável mostrado, ou o ADMIN, grava a
   * anotação `CONTACT` (obrigatória, até 200). Não muda situação nem prazo e vale
   * também em pendência ciente ou encerrada; só o responsável diferente do
   * mostrado é 409.
   */
  async addNote(
    actorId: string,
    id: string,
    input: PendencyNoteInput,
    now: Date,
  ): Promise<void> {
    const { expectedHandlerId, text } = input;
    const { actor, facts } = await this.visibleHandler(
      actorId,
      id,
      expectedHandlerId,
    );
    const expectedState = await this.shownState(facts, expectedHandlerId);
    const outcome = await runPendencyTransition(
      this.prisma,
      this.audit,
      noteTransition({
        recipientId: id,
        actor,
        now,
        expectedHandlerId,
        expectedState,
        text,
      }),
    );
    if (!outcome.ok) {
      throw await this.refusal(actor, outcome, changedConflict);
    }
  }

  /**
   * Encerrar sem ciência (K2-7, DK14): o responsável mostrado, ou o ADMIN
   * (inclusive pendência sem responsável), encerra com motivo obrigatório (até
   * 200). Ciência que chegou antes é 422 `ack_exists`; já encerrada ou
   * responsável diferente do mostrado é 409. Não cria ciência.
   */
  async close(
    actorId: string,
    id: string,
    input: ClosePendencyInput,
    now: Date,
  ): Promise<void> {
    const { expectedHandlerId, reason } = input;
    await this.handled(
      { actorId, id, expectedHandlerId },
      ({ actor, expectedState }) =>
        closeTransition({
          recipientId: id,
          actor,
          now,
          expectedHandlerId,
          expectedState,
          reason,
        }),
      closeConflict,
    );
  }

  /**
   * Reabrir a tratativa (K2-7, DK14): o responsável mostrado, ou o ADMIN, volta
   * uma pendência encerrada sem ciência a "Em tratativa" (ou a "Sem responsável",
   * se não tem responsável), com prazo novo. Aberta, ciente ou responsável
   * diferente do mostrado é 409.
   */
  async reopen(
    actorId: string,
    id: string,
    input: ReopenPendencyInput,
    now: Date,
  ): Promise<void> {
    const { expectedHandlerId } = input;
    await this.handled(
      { actorId, id, expectedHandlerId },
      ({ actor, expectedState }) =>
        reopenTransition({
          recipientId: id,
          actor,
          now,
          expectedHandlerId,
          expectedState,
        }),
      changedConflict,
    );
  }

  /**
   * Encerrar e Reabrir compartilham a porta (`visibleHandler`: só o responsável
   * mostrado ou o ADMIN, DK14), o estado do responsável mostrado e o desfecho;
   * só a transição e a recusa de estado mudam.
   */
  private async handled(
    target: { actorId: string; id: string; expectedHandlerId: string | null },
    build: (ctx: {
      actor: TeamActor;
      expectedState: HandlerState | null;
    }) => PendencyTransition,
    conflict: (
      conflict: PendencyConflict,
      current: HandlerRef | null,
    ) => DomainError,
  ): Promise<void> {
    const { actorId, id, expectedHandlerId } = target;
    const { actor, facts } = await this.visibleHandler(
      actorId,
      id,
      expectedHandlerId,
    );
    const expectedState = await this.shownState(facts, expectedHandlerId);
    const outcome = await runPendencyTransition(
      this.prisma,
      this.audit,
      build({ actor, expectedState }),
    );
    if (!outcome.ok) throw await this.refusal(actor, outcome, conflict);
  }

  /** 403 de não remetente → 404 de alcance → 403 da chave relida (GK5), comum às escritas. */
  private async visibleWriter(actorId: string, id: string) {
    const visible = await requireVisiblePendency(this.prisma, actorId, id);
    requireSendPermission(visible.actor);
    return visible;
  }

  /** `visibleWriter` e, em seguida, 403 `not_handler` (DK12, DK13): só o responsável mostrado ou o ADMIN. */
  private async visibleHandler(
    actorId: string,
    id: string,
    expectedHandlerId: string | null,
  ) {
    const visible = await this.visibleWriter(actorId, id);
    if (requiresHandler(visible.actor, expectedHandlerId)) throw notHandler();
    return visible;
  }

  /** Estado do responsável que a tela mostrava, lido antes da trava (só para a trilha e o tipo do Assumir). */
  private async shownState(
    facts: PendencyScopeFacts,
    expectedHandlerId: string | null,
  ): Promise<HandlerState | null> {
    const [shown] = await handlerStatesFor(this.prisma, [
      { ...facts, handlerId: expectedHandlerId },
    ]);
    return shown?.state ?? null;
  }

  /** 409 com id e nome do responsável de agora (nome pela regra de `nameView`, DK15). */
  private async refusal(
    actor: TeamActor,
    outcome: Extract<PendencyOutcome, { ok: false }>,
    build: (
      conflict: PendencyConflict,
      current: HandlerRef | null,
    ) => DomainError,
  ): Promise<DomainError> {
    const current = await this.handlerRefOf(actor, outcome.current);
    return build(outcome.conflict, current);
  }

  private async handlerRefOf(
    viewer: TeamActor,
    locked: LockedPendency | null,
  ): Promise<HandlerRef | null> {
    const handlerId = locked?.handlerId ?? null;
    if (handlerId === null) return null;
    const handler = (await findTeamActors(this.prisma, [handlerId])).get(
      handlerId,
    );
    const name = nameView(handler?.name ?? '', {
      full: seesFullPhone(viewer),
    });
    return { id: handlerId, name };
  }
}
