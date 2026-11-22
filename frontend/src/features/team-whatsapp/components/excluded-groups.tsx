import { EXCLUSION_LABEL } from "../labels";
import type { TeamExcludedPerson, TeamExclusionReason } from "../schemas";

/** Ordem dos grupos = ordem dos motivos em `EXCLUSION_LABEL` (GF6). Folga e Férias nunca se misturam. */
const REASONS = Object.keys(EXCLUSION_LABEL) as TeamExclusionReason[];

const line = (p: TeamExcludedPerson): string =>
  [p.name, p.sectorName, p.shiftName, p.levelName].filter(Boolean).join(" · ");

/**
 * Quem ficou de fora, agrupado por motivo, com o setor, o turno e o nível considerados. Homônimos são comuns:
 * a chave da linha leva o índice. Sem excluídos não desenha nada.
 */
export function ExcludedGroups({
  excluded,
  title = "Ficaram de fora",
}: {
  excluded: TeamExcludedPerson[];
  title?: string;
}) {
  const groups = REASONS.map((reason) => ({
    reason,
    people: excluded.filter((p) => p.reason === reason),
  })).filter((group) => group.people.length > 0);
  if (groups.length === 0) return null;
  return (
    <section className="space-y-3">
      <h2 className="text-sm font-semibold">
        {title} ({excluded.length})
      </h2>
      {groups.map(({ reason, people }) => {
        const heading = `${EXCLUSION_LABEL[reason]} (${people.length})`;
        return (
          <div key={reason} className="space-y-1">
            <h3 className="text-sm font-medium">{heading}</h3>
            <ul aria-label={heading} className="text-sm text-muted-foreground">
              {people.map((p, index) => (
                <li key={`${index}:${p.userId}`}>{line(p)}</li>
              ))}
            </ul>
          </div>
        );
      })}
    </section>
  );
}
