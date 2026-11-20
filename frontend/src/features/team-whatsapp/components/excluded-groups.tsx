import { EXCLUSION_LABEL } from "../labels";
import { NO_NAME_MATCH_TEXT } from "../name-search";
import type { TeamExcludedPerson, TeamExclusionReason } from "../schemas";

/** Ordem dos grupos = ordem dos motivos em `EXCLUSION_LABEL` (GF6). Folga e Férias nunca se misturam. */
const REASONS = Object.keys(EXCLUSION_LABEL) as TeamExclusionReason[];

const line = (p: TeamExcludedPerson): string =>
  [p.name, p.sectorName, p.shiftName, p.levelName].filter(Boolean).join(" · ");

/**
 * Quem ficou de fora, agrupado por motivo, com o setor, o turno e o nível considerados. Homônimos são comuns:
 * a chave da linha leva o índice. Sem excluídos não desenha nada. `total` só vem com busca por nome ativa:
 * é o tamanho da lista antes do filtro (o título vira "n de m" e, se a busca zera a lista, um aviso fica no lugar).
 */
export function ExcludedGroups({
  excluded,
  title = "Ficaram de fora",
  total,
}: {
  excluded: TeamExcludedPerson[];
  title?: string;
  total?: number;
}) {
  const groups = REASONS.map((reason) => ({
    reason,
    people: excluded.filter((p) => p.reason === reason),
  })).filter((group) => group.people.length > 0);
  if (groups.length === 0 && !total) return null;
  const count =
    total === undefined
      ? `${excluded.length}`
      : `${excluded.length} de ${total}`;
  return (
    <section className="space-y-3">
      <h2 className="text-sm font-semibold">
        {title} ({count})
      </h2>
      {groups.length === 0 && (
        <p className="text-sm text-muted-foreground">{NO_NAME_MATCH_TEXT}</p>
      )}
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
