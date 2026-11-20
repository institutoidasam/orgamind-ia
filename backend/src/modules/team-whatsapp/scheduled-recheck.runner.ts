import {
  audienceRuleSnapshotSchema,
  type AudienceRuleSnapshot,
  type TeamAudienceBase,
} from '../../schemas/contracts/team-whatsapp.schema';
import { todayIn, type CivilDate } from '../staff-schedule/civil-date';
import { classifyPeople, shiftNamesOf } from './audience-people';
import { planRecheck, type RecheckPlan } from './scheduled-recheck';
import { buildAudience } from './team-whatsapp.audience';
import { fromDbBase } from './team-whatsapp.purpose-codes';
import type {
  ClaimedDispatch,
  TeamWhatsappRepository,
} from './team-whatsapp.repository';
import type { LevelFilter } from './team-whatsapp.roster';

/**
 * Leitura da reconferência do agendado (T6b). Mora fora de `scheduled-recheck.ts`
 * (puro) porque o repositório importa `SCHEDULE_GRACE_MS` de lá; aqui o
 * repositório entra só como tipo.
 */

type StoredRule = {
  rule: AudienceRuleSnapshot;
  base: TeamAudienceBase;
  date: CivilDate;
};

/**
 * Regra gravada na criação (DG3). Fora do formato, base ou data de referência
 * nulas → lança: o claim se desfaz, o envio fica SCHEDULED e vence no teto. A
 * mensagem leva só o id do envio (GG8).
 */
function storedRuleOf(claimed: ClaimedDispatch): StoredRule {
  const parsed = audienceRuleSnapshotSchema.safeParse(claimed.audienceRule);
  const base = fromDbBase(claimed.audienceBase);
  if (!parsed.success || !base || !claimed.rosterDate) {
    throw new Error(`Agendado ${claimed.id} sem regra gravada para reconferir`);
  }
  return { rule: parsed.data, base, date: claimed.rosterDate };
}

/** Filtro de nível montado com os níveis gravados (C5), sem consultar os ativos. */
function levelFilterOf(rule: AudienceRuleSnapshot): LevelFilter {
  if (rule.levels.length === 0 && !rule.withoutLevel) return null;
  return {
    levelIds: new Set(rule.levels.map((l) => l.id)),
    withoutLevel: rule.withoutLevel,
  };
}

/**
 * Reconferência do agendado que acabou de vencer o claim (DG2/DG3/DG4): recalcula
 * o público pela regra gravada (setores do envio, turnos com os nomes gravados,
 * níveis, seleção, base, "Incluir folga") na data de referência gravada, sem
 * ator, portas de alcance, disparo amplo nem telefone, e devolve o plano que só
 * retira pessoas. `today` = `todayIn(now)` do tick, nunca o relógio: decide entre
 * o vínculo da data passada e o cadastro. Lê por outra conexão (só leitura).
 */
export async function recheckAudience(
  repo: Pick<TeamWhatsappRepository, 'loadDayPeopleMany'>,
  claimed: ClaimedDispatch,
  now: Date,
): Promise<RecheckPlan> {
  const { rule, base, date } = storedRuleOf(claimed);
  const people = await repo.loadDayPeopleMany(
    claimed.sectors.map((s) => s.id),
    date,
    todayIn(now),
  );
  const audience = buildAudience({
    sectors: classifyPeople({
      base,
      includeOff: claimed.includeOff,
      date,
      sectors: claimed.sectors,
      shiftIds: rule.shifts?.map((s) => s.id) ?? null,
      shiftNames: shiftNamesOf(rule.shifts ?? [], [...people.values()].flat()),
      level: levelFilterOf(rule),
      people,
    }),
    userIds: rule.selectedUserIds ?? undefined,
  });
  return planRecheck({
    frozen: claimed.frozen,
    recipientUserIds: new Set(claimed.recipientUserIds),
    audience,
    selectionWasAll: rule.selectedUserIds === null,
  });
}
