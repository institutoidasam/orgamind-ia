import { useEffect, useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { usePermission } from '@/features/permissions/use-permission';
import { useScheduleOptions } from '@/features/staff-schedule/api';
import type { ScheduleOptions } from '@/features/staff-schedule/schemas';
import { apiErrorText, useExportPeople, type ExportFormat, type PeopleExportParams } from '../api';

/** "Todos" não pode ser '' (o item do Select exige valor): este valor vira parâmetro ausente. */
const ALL = '__all__';
const OPTIONS_ERROR_FALLBACK = 'Não foi possível carregar as opções. Tente de novo.';
const DATE_HINT =
  'Em data passada, setor, turno e nível são os que valiam naquele dia. Telefone, função e situação são sempre os atuais.';

type Choice = { value: string; label: string };
type Status = PeopleExportParams['status'];

const FORMATS: Choice[] = [
  { value: 'csv', label: 'CSV' },
  { value: 'xlsx', label: 'XLSX' },
];
const STATUSES: Choice[] = [
  { value: 'active', label: 'Ativas' },
  { value: 'inactive', label: 'Inativas' },
  { value: 'all', label: 'Todas' },
];

/** Escolhas do formulário; `date` nulo = ainda vale o `today` das opções (DX16). */
type Draft = {
  format: ExportFormat;
  sector: string;
  shift: string;
  status: Status;
  date: string | null;
};

type ChoiceFieldProps = {
  id: string;
  label: string;
  value: string;
  choices: Choice[];
  onChange: (value: string) => void;
};

function ChoiceField({ id, label, value, choices, onChange }: ChoiceFieldProps) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={id} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {choices.map((choice) => (
            <SelectItem key={choice.value} value={choice.value}>
              {choice.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

type FieldsProps = {
  draft: Draft;
  date: string;
  options: ScheduleOptions | undefined;
  set: <K extends keyof Draft>(key: K, value: Draft[K]) => void;
};

function withAll(allLabel: string, items: Array<{ id: string; name: string }> | undefined): Choice[] {
  return [{ value: ALL, label: allLabel }, ...(items ?? []).map((item) => ({ value: item.id, label: item.name }))];
}

function DateField({ date, onChange }: { date: string; onChange: (date: string) => void }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor="export-date">Data de referência</Label>
      <Input
        id="export-date"
        type="date"
        value={date}
        aria-describedby="export-date-hint"
        onChange={(e) => onChange(e.target.value)}
      />
      <p id="export-date-hint" className="text-xs text-muted-foreground">
        {DATE_HINT}
      </p>
    </div>
  );
}

function ExportFields({ draft, date, options, set }: FieldsProps) {
  return (
    <>
      <ChoiceField
        id="export-format"
        label="Formato"
        value={draft.format}
        choices={FORMATS}
        onChange={(v) => set('format', v as ExportFormat)}
      />
      <ChoiceField
        id="export-sector"
        label="Setor"
        value={draft.sector}
        choices={withAll('Todos os setores', options?.sectors)}
        onChange={(v) => set('sector', v)}
      />
      <ChoiceField
        id="export-shift"
        label="Turno"
        value={draft.shift}
        choices={withAll('Todos', options?.shifts)}
        onChange={(v) => set('shift', v)}
      />
      <ChoiceField
        id="export-status"
        label="Situação"
        value={draft.status}
        choices={STATUSES}
        onChange={(v) => set('status', v as Status)}
      />
      <DateField date={date} onChange={(value) => set('date', value)} />
    </>
  );
}

/** Texto da API vem do corpo do erro (assíncrono): começa na reserva e troca ao ler. */
function OptionsError({ error }: { error: unknown }) {
  const [text, setText] = useState(OPTIONS_ERROR_FALLBACK);
  useEffect(() => {
    let current = true;
    void apiErrorText(error, OPTIONS_ERROR_FALLBACK).then((message) => {
      if (current) setText(message);
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

type FormProps = {
  onOpenChange: (open: boolean) => void;
  defaultSectorId?: string;
};

/** Setor que as opções não trazem (ex.: fora do alcance de quem abre) vira "Todos os setores". */
function effectiveSector(sector: string, sectors: ScheduleOptions['sectors'] | undefined): string {
  if (!sectors || sector === ALL || sectors.some((item) => item.id === sector)) return sector;
  return ALL;
}

function useDraft(defaultSectorId: string | undefined, options: ScheduleOptions | undefined) {
  const [draft, setDraft] = useState<Draft>({
    format: 'xlsx',
    sector: defaultSectorId ?? ALL,
    shift: ALL,
    status: 'active',
    date: null,
  });
  const set: FieldsProps['set'] = (key, value) => setDraft((current) => ({ ...current, [key]: value }));
  return {
    draft: { ...draft, sector: effectiveSector(draft.sector, options?.sectors) },
    date: draft.date ?? options?.today ?? '',
    set,
  };
}

/** Só monta com o diálogo aberto: é aqui que as opções são buscadas. */
function ExportPeopleForm({ onOpenChange, defaultSectorId }: FormProps) {
  const options = useScheduleOptions();
  const exportPeople = useExportPeople();
  const canSeeFullPhone = usePermission('telefone.ver_completo');
  const { draft, date, set } = useDraft(defaultSectorId, options.data);
  const submit = () =>
    exportPeople.mutate(
      {
        format: draft.format,
        sectorId: draft.sector === ALL ? undefined : draft.sector,
        shiftId: draft.shift === ALL ? undefined : draft.shift,
        status: draft.status,
        date,
      },
      { onSuccess: () => onOpenChange(false) },
    );
  return (
    <div className="space-y-4 py-2">
      <DialogHeader>
        <DialogTitle>Exportar pessoas</DialogTitle>
      </DialogHeader>
      {options.isError ? (
        <OptionsError error={options.error} />
      ) : (
        <ExportFields draft={draft} date={date} options={options.data} set={set} />
      )}
      {!canSeeFullPhone && <p className="text-sm text-muted-foreground">O telefone sairá mascarado.</p>}
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
          Cancelar
        </Button>
        <Button
          type="button"
          onClick={submit}
          disabled={options.isPending || options.isError || exportPeople.isPending}
        >
          {exportPeople.isPending ? 'Exportando…' : 'Exportar'}
        </Button>
      </DialogFooter>
    </div>
  );
}

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultSectorId?: string;
};

/** Exportar pessoas (spec D3): o erro vai por toast (api.ts) e o diálogo só fecha no sucesso. */
export function ExportPeopleDialog({ open, onOpenChange, defaultSectorId }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby={undefined}>
        <ExportPeopleForm onOpenChange={onOpenChange} defaultSectorId={defaultSectorId} />
      </DialogContent>
    </Dialog>
  );
}
