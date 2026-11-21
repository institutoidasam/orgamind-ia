import { Injectable } from '@nestjs/common';
import type {
  PendencyHandoverInput,
  PendencyHandoverResult,
  PendencyHandoverSkipReason,
  PendencyHandoverTargets,
} from '../../schemas/contracts/team-pendency.schema';
import { AuditService } from '../../shared/audit/audit.service';
import {
  hasPermission,
  permissionDenied,
} from '../../shared/authz/permissions';
import { nameView } from '../../shared/authz/phone-visibility';
import { NotFoundError } from '../../shared/errors/domain.error';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { findTeamActor } from './team-actor.query';
import { listHandlerCandidates } from './team-actors.query';
import { notHandler } from './team-pendency.errors';
import {
  canHandlePendency,
  handlerStateOf,
  pendencyDueAt,
  pendencyScopeOf,
  scopeAllows,
} from './team-pendency.rules';
import {
  canHandoverPendenciesFrom,
  handoverSkipOf,
  isPendencyHandoverTarget,
} from './team-pendency-handover.rules';
import {
  findPendencyScopeFacts,
  type PendencyFacts,
} from './team-pendency-scope.repository';
import {
  runPendencyTransition,
  type PendencyTransition,
} from './team-pendency-write.repository';
import { teamForbidden } from './team-whatsapp.errors';
import { seesFullPhone, sortByViewedName } from './team-whatsapp.name-view';
import { isTeamSender, type TeamActor } from './team-whatsapp.policy';

/**
 * Remetente (403 `forbidden`) com `equipe.enviar` na leitura do banco: o guard só
 * olha o papel do token (K2-7, GK5), e quem perdeu a chave desde o login não
 * lê nem passa pendência (403 `auth.permission_denied`).
 */
function requireSendPermission(actor: TeamActor | null): TeamActor {
  if (actor === null || !isTeamSender(actor)) throw teamForbidden();
  if (!hasPermission(actor, 'equipe.enviar')) {
    throw permissionDenied('equipe.enviar');
  }
  return actor;
}

/** Quem pede, quem sai, o destino (todos relidos do banco) e o que se grava em cada pendência. */
type HandoverPlan = {
  actor: TeamActor;
  fromId: string;
  from: TeamActor | null;
  target: TeamActor;
  note: string;
  now: Date;
};

/**
 * Transição da passagem (K3-4, DT4): espera a pendência aberta, sem ciência, com
 * quem sai como responsável. O destino, já validado e que a vê, vira o
 * responsável `active`; o prazo recomeça em `now` (K2-8) e a observação vira a
 * anotação `HANDOVER` (o prefixo "Passagem de turno: " é da tela). A trilha leva
 * só ids, situações e datas, nunca o texto (DK16).
 */
function handoverTransition(
  plan: HandoverPlan,
  recipientId: string,
  facts: PendencyFacts,
): PendencyTransition {
  const { actor, fromId, from, target, note, now } = plan;
  return {
    recipientId,
    actorId: actor.id,
    now,
    action: 'team_whatsapp.pendency_handover',
    kind: 'handover',
    expect: { handlerId: fromId, closed: false },
    patch: { handlerId: target.id, assignedAt: now, dueAt: pendencyDueAt(now) },
    note: { kind: 'HANDOVER', text: note },
    handlerState: { before: handlerStateOf(from, facts), after: 'active' },
  };
}

/**
 * Passagem de pendências da equipe (Lote K3, K3-4, DT4). O ator, quem sai e o
 * destino são relidos do banco a cada chamada. Cada pendência grava em
 * transação própria por `runPendencyTransition` (GT3), nunca em paralelo.
 */
@Injectable()
export class TeamPendencyHandoverService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Destinos da passagem (K2-7, aceite 28): remetentes ativos, com acesso e com
   * `equipe.enviar`, sem quem sai (`fromUserId`, padrão quem pede), só id e nome.
   * Remetente com a chave (403) → quem sai é o próprio ou o ADMIN (403
   * `not_handler`) → lista. Se o destino vê cada pendência é conferido na
   * passagem, item a item (K2-4).
   */
  async targets(
    actorId: string,
    fromUserId: string | undefined,
  ): Promise<PendencyHandoverTargets> {
    const actor = requireSendPermission(
      await findTeamActor(this.prisma, actorId),
    );
    const from = fromUserId ?? actor.id;
    if (!canHandoverPendenciesFrom(actor, from)) throw notHandler();
    const full = seesFullPhone(actor);
    const items = (await listHandlerCandidates(this.prisma))
      .filter((candidate) => isPendencyHandoverTarget(candidate, from))
      .map(({ id, name }) => ({ id, name: nameView(name, { full }) }));
    return {
      items: sortByViewedName(items, full, (item) => ({ group: 0, ...item })),
    };
  }

  /**
   * Passar as pendências assumidas por quem sai (K3-4, aceite 28). Recusas, nesta
   * ordem (DT4): não remetente (403 `forbidden`) → ator relido sem `equipe.enviar`
   * (403 `auth.permission_denied`) → quem sai é outra pessoa e o ator não é ADMIN
   * (403 `not_handler`) → destino que não pode receber (404 `user.not_found`, o
   * pedido inteiro). Depois, por pendência e em série: fora do alcance de quem
   * pede ou inexistente → `not_found`; fora do alcance do destino →
   * `out_of_scope_target`; senão a transição condicional, e o conflito vira o
   * motivo do pulo (`handoverSkipOf`). As puladas continuam com quem sai.
   */
  async handover(
    actorId: string,
    input: PendencyHandoverInput,
    now: Date,
  ): Promise<PendencyHandoverResult> {
    const actor = requireSendPermission(
      await findTeamActor(this.prisma, actorId),
    );
    const fromId = input.fromUserId ?? actor.id;
    if (!canHandoverPendenciesFrom(actor, fromId)) throw notHandler();
    const target = await findTeamActor(this.prisma, input.toUserId);
    if (target === null || !isPendencyHandoverTarget(target, fromId)) {
      throw new NotFoundError('User', input.toUserId);
    }
    const from = await findTeamActor(this.prisma, fromId);
    const plan = { actor, fromId, from, target, note: input.note, now };
    const result: PendencyHandoverResult = { transferred: [], skipped: [] };
    for (const id of input.pendencyIds) {
      const reason = await this.handoverOne(plan, id);
      if (reason === null) result.transferred.push({ id });
      else result.skipped.push({ id, reason });
    }
    return result;
  }

  /** Uma pendência; `null` = transferida, senão o motivo do pulo (nada gravado). */
  private async handoverOne(
    plan: HandoverPlan,
    id: string,
  ): Promise<PendencyHandoverSkipReason | null> {
    const facts = await findPendencyScopeFacts(this.prisma, id);
    if (facts === null || !scopeAllows(pendencyScopeOf(plan.actor), facts)) {
      return 'not_found';
    }
    if (!canHandlePendency(plan.target, facts)) return 'out_of_scope_target';
    const outcome = await runPendencyTransition(
      this.prisma,
      this.audit,
      handoverTransition(plan, id, facts),
    );
    if (outcome.ok) return null;
    return handoverSkipOf(
      outcome.conflict,
      outcome.current?.handlerId,
      plan.target.id,
    );
  }
}
