import { Button } from "@/components/ui/button";
import type { ShiftRef } from "@/features/shifts/schemas";
import { phoneText } from "@/features/sector-people/phone-text";
import type { TeamRoster } from "@/features/team-whatsapp/schemas";
import { usePanoramaRoster } from "../api";
import { EMPTY_SECTOR_TEXT, PANORAMA_RETRY } from "../labels";

type Member = TeamRoster["sectors"][number]["members"][number];
type PeopleGroup = { title: string; members: Member[] };

const LOADING_TEXT = "Carregando pessoas…";
const LOAD_ERROR_TEXT = "Não foi possível carregar as pessoas";
const NO_NAME_TEXT = "Sem nome";

/**
 * Grupos de "Ver pessoas", na ordem do cartão: um por turno ativo, Outros turnos, Folga, Férias e Sem escala.
 * Grupo vazio não entra. A regra é a das contagens do servidor (turno que não é ativo = Outros turnos).
 */
function peopleGroups(
  members: readonly Member[],
  shifts: readonly ShiftRef[],
): PeopleGroup[] {
  const byShift = new Map(shifts.map((s) => [s.id, [] as Member[]]));
  const other: Member[] = [];
  const dayOff: Member[] = [];
  const vacation: Member[] = [];
  const none: Member[] = [];
  for (const member of members) {
    const situation = member.situation;
    if (situation.kind === "WORK")
      (byShift.get(situation.shiftId) ?? other).push(member);
    else if (situation.kind === "NONE") none.push(member);
    else (situation.reason === "DAY_OFF" ? dayOff : vacation).push(member);
  }
  return [
    ...shifts.map((s) => ({
      title: `${s.name} (${s.startTime}–${s.endTime})`,
      members: byShift.get(s.id) ?? [],
    })),
    { title: "Outros turnos", members: other },
    { title: "Folga", members: dayOff },
    { title: "Férias", members: vacation },
    { title: "Sem escala", members: none },
  ].filter((group) => group.members.length > 0);
}

function GroupList({ group }: { group: PeopleGroup }) {
  return (
    <section aria-label={group.title} className="space-y-1">
      <h4 className="font-medium">{group.title}</h4>
      <ul className="text-muted-foreground">
        {group.members.map((member) => (
          <li key={member.id}>
            {`${member.name ?? NO_NAME_TEXT} · ${phoneText(member)}`}
          </li>
        ))}
      </ul>
    </section>
  );
}

type Props = { sectorId: string; date: string; shifts: readonly ShiftRef[] };

/**
 * Pessoas do setor na data (P4). Montado só no primeiro clique de "Ver pessoas": é a montagem que dispara a
 * busca, e o cartão passa a só esconder a lista. Nome e telefone chegam como o servidor decidiu (mascarados
 * sem `telefone.ver_completo`); aqui nada é derivado nem completado.
 */
export function PanoramaPeople({ sectorId, date, shifts }: Props) {
  const query = usePanoramaRoster(sectorId, date, true);
  if (query.isError) {
    return (
      <div role="alert" className="flex flex-wrap items-center gap-3">
        <p>{LOAD_ERROR_TEXT}</p>
        <Button
          size="sm"
          variant="outline"
          onClick={() => void query.refetch()}
        >
          {PANORAMA_RETRY}
        </Button>
      </div>
    );
  }
  if (!query.data)
    return <p className="text-muted-foreground">{LOADING_TEXT}</p>;
  const members =
    query.data.sectors.find((s) => s.sectorId === sectorId)?.members ?? [];
  const groups = peopleGroups(members, shifts);
  if (groups.length === 0)
    return <p className="text-muted-foreground">{EMPTY_SECTOR_TEXT}</p>;
  return (
    <div className="space-y-3">
      {groups.map((group) => (
        <GroupList key={group.title} group={group} />
      ))}
    </div>
  );
}
