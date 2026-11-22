import { channelLabel, countParts, OFF_REASON_LABEL } from '../error-messages';
import type { DispatchDetail, LeftOutRosterPerson } from '../schemas';
import { RecipientTable } from './recipient-table';

const STATE_LABEL = { SCHEDULED: 'Agendado', CANCELLED: 'Cancelado' } as const;

function whenText(dispatch: DispatchDetail): string {
  const created = new Date(dispatch.createdAt).toLocaleString('pt-BR');
  const author = dispatch.author?.name;
  return author ? `${author} · ${created}` : created;
}

function Counts({ counts }: { counts: DispatchDetail['counts'] }) {
  return (
    <ul aria-label="Contagens por situação" className="flex flex-wrap gap-2 text-sm">
      {countParts(counts).map(({ status, label, count }) => (
        <li key={status} className="rounded-md border px-3 py-1" style={{ borderColor: 'var(--border)' }}>
          {label} {count}
        </li>
      ))}
    </ul>
  );
}

function Channels({ channels }: { channels: DispatchDetail['channels'] }) {
  if (channels.length === 0) return null;
  const several = channels.length > 1;
  return (
    <div className="text-sm">
      <span className="text-muted-foreground">Número: </span>
      {channels.map((c, index) => (
        <p key={`${index}:${c.phoneE164 ?? c.name}`} className="inline-block mr-3">
          {channelLabel(c, several ? c.count : null)}
        </p>
      ))}
    </div>
  );
}

const offText = (person: LeftOutRosterPerson): string =>
  person.reason ? OFF_REASON_LABEL[person.reason] : 'de folga';

/**
 * Quem não recebeu por não estar na seleção ou por estar de folga (a foto gravada no envio). Homônimos
 * são comuns: a chave leva o índice e, com mais de um setor no envio, a linha traz o setor da pessoa.
 */
function LeftOut({ leftOut, showSector }: { leftOut: DispatchDetail['leftOut']; showSector: boolean }) {
  const line = (p: LeftOutRosterPerson, reason: string) =>
    [p.name, showSector ? p.sectorName : null, reason].filter(Boolean).join(' · ');
  const lines = [
    ...leftOut.unselected.map((p) => line(p, 'não selecionado')),
    ...leftOut.off.map((p) => line(p, offText(p))),
  ];
  if (lines.length === 0) return null;
  return (
    <section className="space-y-1">
      <h2 id="left-out-title" className="text-sm font-semibold">Ficaram de fora ({lines.length})</h2>
      <ul aria-labelledby="left-out-title" className="text-sm text-muted-foreground">
        {lines.map((text, index) => <li key={`${index}:${text}`}>{text}</li>)}
      </ul>
    </section>
  );
}

/** Tela de resultado: topo com o envio e as contagens, quem ficou de fora e a lista por nome. */
export function DispatchResult({ dispatch }: { dispatch: DispatchDetail }) {
  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <p className="ds-eyebrow">comunicação · equipe</p>
        <h1 className="text-2xl font-bold">Resultado do envio</h1>
        <p className="font-medium">{dispatch.targetLabel}</p>
        <p className="text-sm text-muted-foreground">
          {whenText(dispatch)}
          {dispatch.state !== 'DISPATCHED' && ` · ${STATE_LABEL[dispatch.state]}`}
        </p>
        <p className="whitespace-pre-wrap rounded-md border p-3 text-sm" style={{ borderColor: 'var(--border)' }}>
          {dispatch.text}
        </p>
        <Channels channels={dispatch.channels} />
        <Counts counts={dispatch.counts} />
      </header>
      <LeftOut leftOut={dispatch.leftOut} showSector={dispatch.sectors.length > 1} />
      <RecipientTable dispatchId={dispatch.id} failedCount={dispatch.counts.failed} />
    </div>
  );
}
