import { Input } from '@/components/ui/input';
import { useDebouncedSearch } from '@/features/sector-people/components/search-state';
import { channelLabel, countParts, OFF_REASON_LABEL } from '../error-messages';
import {
  BASE_LABEL, DISPATCH_STATE_LABEL, dispatchSituation, LEGACY_BASE_LABEL, PURPOSE_LABEL,
} from '../labels';
import { hasTerm, matchesName, narrowedCount, NO_NAME_MATCH_TEXT } from '../name-search';
import type { DispatchDetail, LeftOutRosterPerson, TeamExclusionReason } from '../schemas';
import { ExcludedGroups } from './excluded-groups';
import { RecheckSummary } from './recheck-summary';
import { RecipientTable } from './recipient-table';
import { RulePanel } from './rule-panel';

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
type LeftOutProps = { leftOut: DispatchDetail['leftOut']; showSector: boolean; term: string };

function LeftOut({ leftOut, showSector, term }: LeftOutProps) {
  const line = (p: LeftOutRosterPerson, reason: string) =>
    [p.name, showSector ? p.sectorName : null, reason].filter(Boolean).join(' · ');
  const shown = (people: LeftOutRosterPerson[]) => people.filter((p) => matchesName(p.name, term));
  const lines = [
    ...shown(leftOut.unselected).map((p) => line(p, 'não selecionado')),
    ...shown(leftOut.off).map((p) => line(p, offText(p))),
  ];
  const total = leftOut.unselected.length + leftOut.off.length;
  if (total === 0) return null;
  return (
    <section className="space-y-1">
      <h2 id="left-out-title" className="text-sm font-semibold">
        Ficaram de fora ({narrowedCount(lines.length, total, term)})
      </h2>
      {lines.length === 0 ? (
        <p className="text-sm text-muted-foreground">{NO_NAME_MATCH_TEXT}</p>
      ) : (
        <ul aria-labelledby="left-out-title" className="text-sm text-muted-foreground">
          {lines.map((text, index) => <li key={`${index}:${text}`}>{text}</li>)}
        </ul>
      )}
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

/**
 * Com regra gravada, o painel e os excluídos por motivo; sem ela (envio antigo), só `leftOut` vale. `term` é a busca
 * por nome da tela: filtra a lista e o título dela diz "n de m", nunca as contagens do painel.
 */
function Audience({ dispatch, term }: { dispatch: DispatchDetail; term: string }) {
  if (!dispatch.rule) {
    return <LeftOut leftOut={dispatch.leftOut} showSector={dispatch.sectors.length > 1} term={term} />;
  }
  return (
    <>
      <RulePanel rule={dispatch.rule} includedCount={audienceCount(dispatch)} excludedCount={dispatch.excluded.length} />
      <ExcludedGroups
        excluded={dispatch.excluded.filter((p) => matchesName(p.name, term))}
        total={hasTerm(term) ? dispatch.excluded.length : undefined}
      />
    </>
  );
}

/** Aviso do envio que passou da hora (G5, DG16): nunca saiu, e a saída é criar outro. */
const EXPIRED_NOTICE =
  'Não enviado: passou da hora. O sistema não disparou este envio até 2 horas depois da hora marcada. '
  + 'Se a mensagem ainda fizer sentido, crie um envio novo.';

/** Situação ao lado da data: o enviado comum não a repete; vencido e "Ninguém recebeu" aparecem (DG9, DG16). */
function situationText(dispatch: DispatchDetail): string | null {
  const situation = dispatchSituation(dispatch, new Date());
  return situation === DISPATCH_STATE_LABEL.DISPATCHED ? null : situation;
}

/** Tela de resultado: topo com o envio e as contagens, a regra e quem ficou de fora, e a lista por nome. */
export function DispatchResult({ dispatch }: { dispatch: DispatchDetail }) {
  const { text, setText, q } = useDebouncedSearch();
  const situation = situationText(dispatch);
  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <p className="ds-eyebrow">comunicação · equipe</p>
        <h1 className="text-2xl font-bold">Resultado do envio</h1>
        <p className="font-medium">{dispatch.targetLabel}</p>
        <p className="text-sm text-muted-foreground">
          {whenText(dispatch)}
          {situation && ` · ${situation}`}
        </p>
        {situation === DISPATCH_STATE_LABEL.EXPIRED && (
          <p role="status" className="rounded-md border p-3 text-sm" style={{ borderColor: 'var(--border)' }}>
            {EXPIRED_NOTICE}
          </p>
        )}
        {!dispatch.rule && !isPersonTarget(dispatch) && <LegacyRule dispatch={dispatch} />}
        <p className="whitespace-pre-wrap rounded-md border p-3 text-sm" style={{ borderColor: 'var(--border)' }}>
          {dispatch.text}
        </p>
        <Channels channels={dispatch.channels} />
        <Counts counts={dispatch.counts} />
      </header>
      <Input
        type="search"
        aria-label="Buscar pessoa pelo nome"
        placeholder="Buscar pessoa pelo nome"
        className="max-w-sm"
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      <Audience dispatch={dispatch} term={q} />
      <RecheckSummary recheck={dispatch.recheck} term={q} />
      <RecipientTable dispatchId={dispatch.id} failedCount={dispatch.counts.failed} query={q} />
    </div>
  );
}
