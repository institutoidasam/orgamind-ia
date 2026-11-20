import { manausDateTime } from "../labels";
import { matchesName, narrowedCount, NO_NAME_MATCH_TEXT } from "../name-search";
import type { DispatchDetail, TeamAudiencePerson } from "../schemas";

type Recheck = NonNullable<DispatchDetail["recheck"]>;

const line = (p: TeamAudiencePerson): string =>
  [p.name, p.sectorName, p.shiftName].filter(Boolean).join(" · ");

/** "Reconferido em 20/11/2026 às 09:00: 2 pulado(s)." (G3): a hora do disparo em Manaus. */
function recheckText({ at, skipped }: Recheck): string {
  const { date, time } = manausDateTime(at);
  return `Reconferido em ${date} às ${time}: ${skipped} pulado(s).`;
}

/**
 * Quem entrou no público depois do agendamento não recebeu (G3): nome, setor e turno, sem telefone. Homônimos são
 * comuns: a chave leva o índice. `term` é a busca por nome da tela (sem acento, sem caixa): com termo o título diz
 * "n de m" e a busca que zera a lista deixa o aviso no lugar dela.
 */
function LateJoined({
  people,
  term,
}: {
  people: TeamAudiencePerson[];
  term: string;
}) {
  if (people.length === 0) return null;
  const shown = people.filter((p) => matchesName(p.name, term));
  return (
    <div className="space-y-1">
      <h2 id="late-joined-title" className="text-sm font-semibold">
        Entraram depois do agendamento, não receberam (
        {narrowedCount(shown.length, people.length, term)})
      </h2>
      {shown.length === 0 ? (
        <p className="text-sm text-muted-foreground">{NO_NAME_MATCH_TEXT}</p>
      ) : (
        <ul
          aria-labelledby="late-joined-title"
          className="text-sm text-muted-foreground"
        >
          {shown.map((p, index) => (
            <li key={`${index}:${p.userId}`}>{line(p)}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * O que a reconferência do disparo fez (G3): a hora, quantos foram pulados e quem entrou depois e ficou de fora.
 * Sem `recheck` (envio imediato, antigo, cancelado, vencido ou ainda agendado) não desenha nada.
 */
export function RecheckSummary({
  recheck,
  term,
}: {
  recheck: DispatchDetail["recheck"];
  term: string;
}) {
  if (!recheck) return null;
  return (
    <section aria-label="Reconferência do disparo" className="space-y-2">
      <p className="text-sm">{recheckText(recheck)}</p>
      <LateJoined people={recheck.lateJoined} term={term} />
    </section>
  );
}
