import { formatDayMonth } from '@/lib/civil-date';
import type {
  LeftOutPerson, RecipientPreview, SendTarget, TeamAudiencePerson, TeamAudiencePreview, TeamExcludedPerson,
} from './schemas';

/** Quem vai receber, como a prévia do servidor o devolve (o telefone vem mascarado ou não, conforme a permissão). */
export type ReceivingPerson = TeamAudiencePreview['included'][number];

/** Uma área da lista "Vão receber": a que o servidor usa para mandar (`sectorId`, CF3). */
export type AreaGroup = { sectorId: string; name: string; people: ReceivingPerson[] };

/**
 * Quem vai receber, por área, na ordem dos setores da regra. A pessoa traz a área por onde o servidor manda
 * (remanejado A→B: B na base em serviço, A na vinculada) e conta uma vez, só nessa área.
 */
export function receivingByArea({ rule, included }: TeamAudiencePreview): AreaGroup[] {
  const groups = rule.sectors.map(({ id, name }): AreaGroup => ({ sectorId: id, name, people: [] }));
  for (const person of included) {
    let group = groups.find((g) => g.sectorId === person.sectorId);
    if (!group) {
      group = { sectorId: person.sectorId, name: person.sectorName, people: [] };
      groups.push(group);
    }
    group.people.push(person);
  }
  return groups;
}

/** Candidatos que só ficaram de fora porque há seleção ("Não selecionado"): a tela os deixa marcar. */
export function unselectedPeople({ excluded }: Pick<TeamAudiencePreview, 'excluded'>): TeamExcludedPerson[] {
  return excluded.filter((p) => p.reason === 'not_selected');
}

/** Quem está fora por motivo próprio (Folga, Férias, Sem telefone...): só informativo, sem caixa de marcar (C3). */
export function leftOutByReason({ excluded }: Pick<TeamAudiencePreview, 'excluded'>): TeamExcludedPerson[] {
  return excluded.filter((p) => p.reason !== 'not_selected');
}

/** Ids que a tela deixa marcar: os que vão receber e os "Não selecionado". */
export function markableIds(preview: TeamAudiencePreview): string[] {
  return [...preview.included, ...unselectedPeople(preview)].map((p) => p.userId);
}

/** Marca todos os marcáveis; se já estavam todos marcados, limpa a seleção (volta a "todos"). */
export function toggleAllMarkable(ids: readonly string[], selected: ReadonlySet<string>): Set<string> {
  const allOn = ids.length > 0 && ids.every((id) => selected.has(id));
  return allOn ? new Set() : new Set([...selected, ...ids]);
}

/** Marcados que a prévia manteve em "Vão receber" (quem foi marcado e está de fora fica de fora, com o motivo). */
export function markedReceiving(included: readonly ReceivingPerson[], selected: ReadonlySet<string>): ReceivingPerson[] {
  return included.filter((p) => selected.has(p.userId));
}

const SEM_NIVEL = 'Sem nível';

/** Até dois nomes por ", "; com mais, os dois primeiros e " +N" ("RH, TI +2"). */
function namesLabel(names: readonly string[]): string {
  const shown = names.slice(0, 2).join(', ');
  return names.length > 2 ? `${shown} +${names.length - 2}` : shown;
}

/** Mesmo rótulo que o back grava em `targetLabel` (GC12), montado da regra que o servidor aplicou. */
function sectorLabel({ rule }: TeamAudiencePreview, selectedCount: number | null): string {
  const sectors = rule.sectors.map((s) => s.name).sort((a, b) => a.localeCompare(b, 'pt-BR'));
  const levels = [...rule.levels.map((l) => l.name), ...(rule.withoutLevel ? [SEM_NIVEL] : [])];
  return [
    namesLabel(sectors),
    ...(levels.length > 0 ? [namesLabel(levels)] : []),
    rule.shifts ? namesLabel(rule.shifts.map((s) => s.name)) : 'todos os turnos',
    formatDayMonth(rule.rosterDate),
    ...(selectedCount === null ? [] : [`seleção de ${selectedCount}`]),
  ].join(' · ');
}

const recipient = (p: TeamAudiencePerson): RecipientPreview => ({ id: p.userId, name: p.name });

const LEFT_OUT_REASON: Partial<Record<TeamExcludedPerson['reason'], LeftOutPerson['reason']>> = {
  not_selected: 'unselected',
  no_phone: 'no_phone',
  not_authorized: 'not_authorized',
};

/** Quem a confirmação ainda sabe mostrar como "fica de fora"; os outros motivos são do diálogo novo (T15). */
function leftOutOf(excluded: readonly TeamExcludedPerson[]): LeftOutPerson[] {
  return excluded.flatMap(({ name, reason }): LeftOutPerson[] => {
    const known = LEFT_OUT_REASON[reason];
    return known ? [{ name, reason: known }] : [];
  });
}

type SectorTargetInput = {
  /** Prévia do corpo atual (a que o operador viu). */
  preview: TeamAudiencePreview;
  /** Setores pedidos, na ordem da tela (a mesma da consulta da escala). */
  sectorIds: readonly string[];
  /** Ids marcados, os mesmos que foram na prévia; vazio = "Enviar para todos". */
  selectedIds: readonly string[];
};

/**
 * Alvo do diálogo de envio, com a lista conferida: pessoas e regra vêm da prévia do servidor, não do quadro. O "seleção
 * de N" conta os ids marcados, como o `targetLabel` que o servidor grava, e não só os que a prévia manteve.
 */
export function buildSectorTarget({ preview, sectorIds, selectedIds }: SectorTargetInput): SendTarget {
  const { rule, included, excluded } = preview;
  const marked = selectedIds.length > 0;
  return {
    type: 'sector',
    sectorIds: [...sectorIds],
    levelIds: rule.levels.map((l) => l.id),
    withoutLevel: rule.withoutLevel,
    label: sectorLabel(preview, marked ? selectedIds.length : null),
    date: rule.rosterDate,
    shiftIds: rule.shifts?.map((s) => s.id) ?? [],
    includeOff: rule.includeOff,
    userIds: marked ? [...selectedIds] : null,
    recipients: included.map(recipient),
    leftOut: leftOutOf(excluded),
  };
}
