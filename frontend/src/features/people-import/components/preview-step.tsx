import { useEffect, useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { readApiErrorBody } from '@/lib/api-error';
import { useImportRows, type ConfirmSelection } from '../api';
import { confirmText, ROW_CLASS_LABEL } from '../labels';
import { ROW_CLASSES, type BatchSummary, type RowClass, type RowView } from '../schemas';
import { ConfirmDialog } from './confirm-dialog';
import { PreviewTable, type RowGeneral } from './preview-table';

const PHONE_DEFERRED_TEXT = 'A conferência de telefones já cadastrados é feita ao gravar.';
const ROWS_ERROR_FALLBACK = 'Não foi possível carregar as linhas da prévia. Tente de novo.';

type Group = keyof RowGeneral;
const GROUP_CLASS: Record<Group, RowClass> = {
  createNew: 'CREATE',
  updateExisting: 'UPDATE',
};

/** Padrão da escolha: os dois grupos marcados, nenhuma linha tirada. */
const ALL_GROUPS: RowGeneral = { createNew: true, updateExisting: true };

/**
 * A escolha vive na tela: os dois marcadores gerais e as linhas tiradas à mão (número → grupo).
 * O servidor recebe só as tiradas de grupo marcado e decide o que entra (EX7), junto com o
 * mapeamento da prévia mostrada; `reset` volta ao padrão quando essa prévia deixa de valer.
 */
function useSelection({ counts, mapping }: Pick<BatchSummary, 'counts' | 'mapping'>) {
  const [general, setGeneral] = useState<RowGeneral>(ALL_GROUPS);
  const [excluded, setExcluded] = useState<ReadonlyMap<number, Group>>(new Map());
  const remaining = (group: Group) =>
    (counts?.[GROUP_CLASS[group]] ?? 0) - [...excluded.values()].filter((g) => g === group).length;
  const toggleRow = (row: RowView) => {
    const group = row.classification === 'CREATE' ? 'createNew' : 'updateExisting';
    setExcluded((current) => {
      const next = new Map(current);
      if (!next.delete(row.rowNumber)) next.set(row.rowNumber, group);
      return next;
    });
  };
  const toCreate = general.createNew ? remaining('createNew') : 0;
  const toUpdate = general.updateExisting ? remaining('updateExisting') : 0;
  const selection: ConfirmSelection = {
    ...general,
    excludedRows: [...excluded]
      .filter(([, group]) => general[group])
      .map(([rowNumber]) => rowNumber)
      .sort((a, b) => a - b),
    mapping,
  };
  return {
    general,
    excluded: new Set(excluded.keys()),
    remaining,
    toggleRow,
    setGeneral: (group: Group, value: boolean) => setGeneral((current) => ({ ...current, [group]: value })),
    reset: () => {
      setGeneral(ALL_GROUPS);
      setExcluded(new Map());
    },
    toCreate,
    toUpdate,
    selection,
  };
}

type Selection = ReturnType<typeof useSelection>;

function GeneralMarker({ group, label, selection }: { group: Group; label: string; selection: Selection }) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <Checkbox
        checked={selection.general[group]}
        onCheckedChange={(value) => selection.setGeneral(group, value === true)}
      />
      <span>{`${label} (${selection.remaining(group)})`}</span>
    </label>
  );
}

type FilterProps = {
  counts: BatchSummary['counts'];
  value: RowClass | undefined;
  onChange: (value: RowClass | undefined) => void;
};

/** Contadores por classificação; cada um é também o filtro daquela classificação. */
function ClassFilter({ counts, value, onChange }: FilterProps) {
  const total = ROW_CLASSES.reduce((sum, rowClass) => sum + (counts?.[rowClass] ?? 0), 0);
  const options: Array<[RowClass | undefined, string, number]> = [
    [undefined, 'Todas', total],
    ...ROW_CLASSES.map((rowClass): [RowClass, string, number] => [
      rowClass,
      ROW_CLASS_LABEL[rowClass],
      counts?.[rowClass] ?? 0,
    ]),
  ];
  return (
    <div role="group" aria-label="Filtrar por classificação" className="flex flex-wrap gap-2">
      {options.map(([rowClass, label, count]) => (
        <Button
          key={label}
          size="sm"
          variant={value === rowClass ? 'default' : 'outline'}
          aria-pressed={value === rowClass}
          onClick={() => onChange(rowClass)}
        >
          {label} <span className="tabular-nums">{count}</span>
        </Button>
      ))}
    </div>
  );
}

/** O texto do ProblemDetails (ex.: prévia indisponível) vale mais que a mensagem genérica. */
function RowsError({ error }: { error: unknown }) {
  const [text, setText] = useState(ROWS_ERROR_FALLBACK);
  useEffect(() => {
    let current = true;
    void readApiErrorBody(error).then((body) => {
      if (current && body?.detail) setText(body.detail);
    });
    return () => {
      current = false;
    };
  }, [error]);
  return (
    <Alert variant="destructive">
      <AlertDescription>{text}</AlertDescription>
    </Alert>
  );
}

type PagerProps = {
  page: number;
  pages: number;
  onChange: (page: number) => void;
};

function Pager({ page, pages, onChange }: PagerProps) {
  return (
    <div className="flex items-center justify-end gap-2">
      <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => onChange(page - 1)}>
        Anterior
      </Button>
      <span className="text-sm text-muted-foreground">{`Página ${page} de ${pages}`}</span>
      <Button size="sm" variant="outline" disabled={page >= pages} onClick={() => onChange(page + 1)}>
        Próxima
      </Button>
    </div>
  );
}

type FooterProps = {
  canConfirm: boolean;
  selection: Selection;
  onBack: () => void;
  onConfirm: () => void;
};

/** A contagem final fica ao lado do botão; sem nenhuma linha escolhida não há o que confirmar. */
function Footer({ canConfirm, selection, onBack, onConfirm }: FooterProps) {
  const nothingSelected = selection.toCreate + selection.toUpdate === 0;
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <Button variant="ghost" onClick={onBack}>
        Voltar às colunas
      </Button>
      <div className="flex items-center gap-3">
        <span className="text-sm">{confirmText(selection.toCreate, selection.toUpdate)}</span>
        <Button disabled={nothingSelected || !canConfirm} onClick={onConfirm}>
          Confirmar importação
        </Button>
      </div>
    </div>
  );
}

type RowsProps = {
  batchId: string;
  filter: RowClass | undefined;
  selection: Selection;
};

/** Linhas da página atual (50 por página) com o paginador; a página volta à 1ª quando o filtro muda. */
function RowsSection({ batchId, filter, selection }: RowsProps) {
  const [page, setPage] = useState(1);
  const [lastFilter, setLastFilter] = useState(filter);
  if (lastFilter !== filter) {
    setLastFilter(filter);
    setPage(1);
  }
  const rows = useImportRows(batchId, page, filter);
  const pages = rows.data ? Math.max(1, Math.ceil(rows.data.total / rows.data.pageSize)) : 1;
  return (
    <>
      {rows.isError && <RowsError error={rows.error} />}
      {rows.data && (
        <PreviewTable
          rows={rows.data.items}
          general={selection.general}
          excluded={selection.excluded}
          onToggle={selection.toggleRow}
        />
      )}
      {rows.data?.items.length === 0 && (
        <p className="text-sm text-muted-foreground">Nenhuma linha nesta classificação.</p>
      )}
      <Pager page={page} pages={pages} onChange={setPage} />
    </>
  );
}

type Props = {
  batch: BatchSummary;
  onConfirmed: (summary: BatchSummary) => void;
  onBack: () => void;
};

/** Passo "Prévia" (E5): contadores, filtro, linhas paginadas, escolha do conjunto e confirmação. */
export function PreviewStep({ batch, onConfirmed, onBack }: Props) {
  const [filter, setFilter] = useState<RowClass | undefined>();
  const [confirming, setConfirming] = useState(false);
  const selection = useSelection(batch);
  return (
    <div className="space-y-4">
      {batch.phoneCheckDeferred && (
        <Alert>
          <AlertDescription>{PHONE_DEFERRED_TEXT}</AlertDescription>
        </Alert>
      )}
      <ClassFilter counts={batch.counts} value={filter} onChange={setFilter} />
      <div className="flex flex-wrap gap-x-6 gap-y-2">
        <GeneralMarker group="createNew" label="Criar pessoas novas" selection={selection} />
        <GeneralMarker group="updateExisting" label="Atualizar pessoas existentes" selection={selection} />
      </div>
      <RowsSection batchId={batch.id} filter={filter} selection={selection} />
      <Footer
        canConfirm={batch.canConfirm}
        selection={selection}
        onBack={onBack}
        onConfirm={() => setConfirming(true)}
      />
      <ConfirmDialog
        batchId={batch.id}
        open={confirming}
        onOpenChange={setConfirming}
        toCreate={selection.toCreate}
        toUpdate={selection.toUpdate}
        selection={selection.selection}
        onConfirmed={(summary) => {
          setConfirming(false);
          onConfirmed(summary);
        }}
        onPreviewChanged={selection.reset}
      />
    </div>
  );
}
