import { channelLabel, countParts, OFF_REASON_LABEL } from '../error-messages';
import { BASE_LABEL, LEGACY_BASE_LABEL, PURPOSE_LABEL } from '../labels';
import type { DispatchDetail, LeftOutRosterPerson, TeamExclusionReason } from '../schemas';
import { ExcludedGroups } from './excluded-groups';
import { RecipientTable } from './recipient-table';
import { RulePanel } from './rule-panel';

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

/**
 * Envio a uma pessoa não tem finalidade nem base (não muda nesta etapa): o detalhe não traz o alvo, mas todo
 * envio a setor grava ao menos um setor (migração D5) e o envio a uma pessoa grava `sectors: []`.
 */
const isPersonTarget = (dispatch: DispatchDetail): boolean => dispatch.sectors.length === 0;

/** Envio a setor anterior à finalidade (C5, GF13): finalidade `—` e base `equipe em serviço (regra anterior)`. */
function LegacyRule({ dispatch }: { dispatch: DispatchDetail }) {
  const purpose = dispatch.purpose ? PURPOSE_LABEL[dispatch.purpose] : '—';
  const base = dispatch.base ? BASE_LABEL[dispatch.base] : LEGACY_BASE_LABEL;
  return <p className="text-sm text-muted-foreground">{`Finalidade: ${purpose} · Base: ${base}`}</p>;
}

/**
 * Motivos de telefone: o servidor grava essas pessoas como excluídas E como destinatários `SKIPPED` (DF3).
 * É o mesmo conjunto de `PHONE_SKIP` do back.
 */
const PHONE_EXCLUSIONS: ReadonlySet<TeamExclusionReason> = new Set(['no_phone', 'suppressed', 'not_authorized']);

/**
 * "No público": quem foi de fato para a fila ou o agendamento, como o `included` da prévia (aceite 12). A soma das
 * situações conta também os pulados por telefone, que já aparecem em "De fora": sai uma vez cada um.
 */
function audienceCount({ counts, excluded }: DispatchDetail): number {
  const recorded = Object.values(counts).reduce((sum, count) => sum + count, 0);
  return recorded - excluded.filter((p) => PHONE_EXCLUSIONS.has(p.reason)).length;
}

/** Com regra gravada, o painel e os excluídos por motivo; sem ela (envio antigo), só `leftOut` vale. */
function Audience({ dispatch }: { dispatch: DispatchDetail }) {
  if (!dispatch.rule) {
    return <LeftOut leftOut={dispatch.leftOut} showSector={dispatch.sectors.length > 1} />;
  }
  return (
    <>
      <RulePanel rule={dispatch.rule} includedCount={audienceCount(dispatch)} excludedCount={dispatch.excluded.length} />
      <ExcludedGroups excluded={dispatch.excluded} />
    </>
  );
}

/** Tela de resultado: topo com o envio e as contagens, a regra e quem ficou de fora, e a lista por nome. */
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
        {!dispatch.rule && !isPersonTarget(dispatch) && <LegacyRule dispatch={dispatch} />}
        <p className="whitespace-pre-wrap rounded-md border p-3 text-sm" style={{ borderColor: 'var(--border)' }}>
          {dispatch.text}
        </p>
        <Channels channels={dispatch.channels} />
        <Counts counts={dispatch.counts} />
      </header>
      <Audience dispatch={dispatch} />
      <RecipientTable dispatchId={dispatch.id} failedCount={dispatch.counts.failed} />
    </div>
  );
}
