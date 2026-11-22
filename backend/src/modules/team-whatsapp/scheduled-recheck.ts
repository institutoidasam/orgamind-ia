import type { AudienceEntry, AudienceRuleReason } from './audience-classify';
import type { Audience } from './team-whatsapp.audience';

/**
 * Reconferência do agendado (CG6, G3 da spec): função pura, sem banco, relógio
 * nem I/O. Só importa tipos (o repositório importa `SCHEDULE_GRACE_MS` daqui).
 */

/** Teto de atraso: agendado que não disparou até 2 h depois da hora marcada não sai mais. */
export const SCHEDULE_GRACE_MS = 2 * 60 * 60 * 1000;

/** Mesmos nomes do enum Prisma do motivo de pulo do destinatário. */
export type RecheckSkipReason =
  'VACATION' | 'DAY_OFF' | 'LEFT_SECTOR' | 'INACTIVE';

/** Destinatário ainda `SCHEDULED` (linha congelada na criação do envio). */
export type FrozenRecipient = {
  id: string;
  userId: string | null;
  userActive: boolean;
};

/** Quem passou a se enquadrar depois do agendamento (sem telefone, GG8). */
export type LateJoinedPerson = {
  userId: string;
  name: string;
  sectorId: string;
  sectorName: string;
  shiftName: string | null;
  levelName: string | null;
};

export type RecheckPlan = {
  skips: { recipientId: string; reason: RecheckSkipReason }[];
  lateJoined: LateJoinedPerson[];
};

/**
 * Motivo da prévia traduzido para os quatro da reconferência (DG4). Setor, turno
 * e seleção viram "Saiu do setor ou turno": não se cria um quinto motivo.
 */
const SKIP_OF_RULE: Record<AudienceRuleReason, RecheckSkipReason> = {
  vacation: 'VACATION',
  day_off: 'DAY_OFF',
  other_sector: 'LEFT_SECTOR',
  other_shift: 'LEFT_SECTOR',
  not_selected: 'LEFT_SECTOR',
};

const collator = new Intl.Collator('pt-BR');

/** Precedência DG4: inativa, fica se incluída, motivo da regra, ausente do público. */
function skipReasonOf(
  recipient: FrozenRecipient,
  included: ReadonlySet<string>,
  excluded: ReadonlyMap<string, AudienceRuleReason>,
): RecheckSkipReason | null {
  const { userId, userActive } = recipient;
  if (userId === null || !userActive) return 'INACTIVE';
  if (included.has(userId)) return null;
  const rule = excluded.get(userId);
  return rule ? SKIP_OF_RULE[rule] : 'LEFT_SECTOR';
}

const nameOf = (m: { name: string | null; email: string | null }) =>
  m.name ?? m.email ?? '';

const lateJoinedOf = (entry: AudienceEntry): LateJoinedPerson => ({
  userId: entry.member.id,
  name: nameOf(entry.member),
  sectorId: entry.sectorId,
  sectorName: entry.sectorName,
  shiftName: entry.shiftName,
  levelName: entry.levelName,
});

/** Incluídos sem nenhuma linha no envio, pelo nome (desempate pelo id). */
function lateJoinedFrom(
  audience: Audience,
  recipientUserIds: ReadonlySet<string>,
): LateJoinedPerson[] {
  return audience.included
    .filter(({ member }) => !recipientUserIds.has(member.id))
    .map(lateJoinedOf)
    .sort(
      (a, b) =>
        collator.compare(a.name, b.name) || a.userId.localeCompare(b.userId),
    );
}

/**
 * Plano da reconferência (DG4): só retira pessoas de `frozen` (GG3/GG4), nunca
 * cita um `recipientId` de fora dela nem cria destinatário. `audience` é o
 * público recalculado pela regra, antes da divisão por telefone: quem está
 * entre os incluídos fica (inclusive com "Incluir folga"). `recipientUserIds`
 * são os usuários de todas as linhas do envio, de qualquer situação. "Entraram
 * depois" só existe quando a seleção gravada era "todos os aptos".
 */
export function planRecheck(input: {
  frozen: readonly FrozenRecipient[];
  recipientUserIds: ReadonlySet<string>;
  audience: Audience;
  selectionWasAll: boolean;
}): RecheckPlan {
  const { frozen, recipientUserIds, audience, selectionWasAll } = input;
  const included = new Set(audience.included.map((e) => e.member.id));
  const excluded = new Map(
    audience.excluded.flatMap((e) =>
      e.reason === null ? [] : [[e.member.id, e.reason] as const],
    ),
  );
  const skips = frozen.flatMap((recipient) => {
    const reason = skipReasonOf(recipient, included, excluded);
    return reason ? [{ recipientId: recipient.id, reason }] : [];
  });
  const lateJoined = selectionWasAll
    ? lateJoinedFrom(audience, recipientUserIds)
    : [];
  return { skips, lateJoined };
}
