import { useState, type ReactNode } from 'react';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { addDays, isoWeekday, mondayOf } from '@/lib/civil-date';
import { useDeleteSchedule, usePutSchedule } from '../api';
import { describeScheduleError } from '../error-messages';
import type { ScheduleOptions, ScheduleTemplate, StaffSchedule } from '../schemas';
import { applyPreset, custom, resizeCycle, type PresetTemplate } from '../templates';

/** Pessoa da linha; `schedule` nulo = ainda segue o turno do cadastro. */
export type ScheduleTarget = { userId: string; name: string; schedule: StaffSchedule | null };

type Props = {
  target: ScheduleTarget;
  options: Pick<ScheduleOptions, 'today' | 'shifts'>;
  onClose: () => void;
};

type Shifts = ScheduleOptions['shifts'];
type Picks = { a: string; b: string };

const WEEKDAYS = ['seg', 'ter', 'qua', 'qui', 'sex', 'sáb', 'dom'];
const OFF = 'OFF';
const SAVE_FALLBACK = 'Não foi possível salvar a escala.';
const REMOVE_FALLBACK = 'Não foi possível remover a escala.';
const INVALID_SHIFT_CODE = 'staff_schedule.invalid_shift';
const INVALID_SHIFT_TEXT = 'Um dos turnos não está mais disponível. Atualize a página.';

const TEMPLATE_LABELS: Record<ScheduleTemplate, string> = {
  WEEKLY: 'Semanal',
  WEEKLY_ROTATION: 'Rodízio semanal',
  TWELVE_36: '12x36',
  CUSTOM: 'Personalizado',
};

/** Seletores de turno de cada modelo pronto (A = primeiro/único, B = segunda semana do rodízio). */
const PICK_FIELDS: Record<PresetTemplate, { key: keyof Picks; label: string }[]> = {
  WEEKLY: [{ key: 'a', label: 'Turno' }],
  WEEKLY_ROTATION: [{ key: 'a', label: 'Turno da semana A' }, { key: 'b', label: 'Turno da semana B' }],
  TWELVE_36: [{ key: 'a', label: 'Turno' }],
};

function initialPicks(schedule: StaffSchedule, shifts: Shifts): Picks {
  const worked = schedule.days.filter((day): day is string => day !== null);
  const a = worked[0] ?? shifts[0]?.id ?? '';
  return { a, b: worked.length > 0 ? worked[worked.length - 1] : (shifts[1]?.id ?? a) };
}

function useDraft(target: ScheduleTarget, options: Props['options']) {
  const [draft, setDraft] = useState<StaffSchedule>(
    () => target.schedule ?? custom(7, mondayOf(options.today)),
  );
  const [picks, setPicks] = useState(() => initialPicks(draft, options.shifts));
  const preset = (template: PresetTemplate, nextPicks: Picks, startDate: string) =>
    nextPicks.a === '' ? { ...draft, template } : applyPreset(template, { shiftA: nextPicks.a, shiftB: nextPicks.b, startDate });
  const setTemplate = (template: ScheduleTemplate) =>
    setDraft(template === 'CUSTOM' ? { ...draft, template } : preset(template, picks, draft.startDate));
  const setPick = (key: keyof Picks, shiftId: string) => {
    const next = { ...picks, [key]: shiftId };
    setPicks(next);
    if (draft.template !== 'CUSTOM') setDraft(preset(draft.template, next, draft.startDate));
  };
  const setStart = (date: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
    const aligned = draft.template === 'WEEKLY' || draft.template === 'WEEKLY_ROTATION';
    setDraft({ ...draft, startDate: aligned ? mondayOf(date) : date });
  };
  const setCycle = (size: number) => {
    if (Number.isInteger(size) && size >= 1 && size <= 28) setDraft(resizeCycle(draft, size));
  };
  const setDay = (index: number, shiftId: string | null) =>
    setDraft({ ...draft, days: draft.days.map((day, i) => (i === index ? shiftId : day)) });
  return { draft, picks, setTemplate, setPick, setStart, setCycle, setDay };
}

function useSubmit(target: ScheduleTarget, draft: StaffSchedule, onClose: () => void) {
  const put = usePutSchedule();
  const remove = useDeleteSchedule();
  const [error, setError] = useState<string | null>(null);
  const run = async (request: () => Promise<unknown>, fallback: string) => {
    setError(null);
    try {
      await request();
      onClose();
    } catch (failure) {
      const { code, message } = await describeScheduleError(failure, fallback);
      setError(code === INVALID_SHIFT_CODE ? INVALID_SHIFT_TEXT : message);
    }
  };
  return {
    error,
    pending: put.isPending || remove.isPending,
    save: () => run(() => put.mutateAsync({ userId: target.userId, body: draft }), SAVE_FALLBACK),
    removeSchedule: () => run(() => remove.mutateAsync(target.userId), REMOVE_FALLBACK),
  };
}

export function ScheduleEditorDialog({ target, options, onClose }: Props) {
  const form = useDraft(target, options);
  const submit = useSubmit(target, form.draft, onClose);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Editar escala</DialogTitle>
          <DialogDescription>{target.name}</DialogDescription>
        </DialogHeader>
        <form onSubmit={(event) => { event.preventDefault(); void submit.save(); }} className="space-y-4 py-2">
          <TemplateFields form={form} shifts={options.shifts} />
          <CycleFields form={form} />
          <DayList form={form} shifts={options.shifts} />
          {submit.error && <p role="alert" className="text-sm text-destructive">{submit.error}</p>}
          <DialogFooter>
            {target.schedule && <RemoveButton disabled={submit.pending} onConfirm={submit.removeSchedule} />}
            <Button type="button" variant="ghost" onClick={onClose}>Cancelar</Button>
            <Button type="submit" disabled={submit.pending}>{submit.pending ? 'Salvando...' : 'Salvar'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

type Form = ReturnType<typeof useDraft>;

function Field({ label, htmlFor, children }: { label: string; htmlFor?: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
    </div>
  );
}

function ShiftSelect({ label, value, shifts, onChange }: {
  label: string; value: string; shifts: Shifts; onChange: (shiftId: string) => void;
}) {
  return (
    <Field label={label}>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger aria-label={label}><SelectValue placeholder="Escolha o turno" /></SelectTrigger>
        <SelectContent>
          {shifts.map((shift) => <SelectItem key={shift.id} value={shift.id}>{shift.name}</SelectItem>)}
        </SelectContent>
      </Select>
    </Field>
  );
}

function TemplateFields({ form, shifts }: { form: Form; shifts: Shifts }) {
  const { draft } = form;
  return (
    <>
      <Field label="Modelo">
        <Select value={draft.template} onValueChange={(value) => form.setTemplate(value as ScheduleTemplate)}>
          <SelectTrigger aria-label="Modelo"><SelectValue /></SelectTrigger>
          <SelectContent>
            {Object.entries(TEMPLATE_LABELS).map(([value, label]) => (
              <SelectItem key={value} value={value}>{label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      {draft.template !== 'CUSTOM' && PICK_FIELDS[draft.template].map(({ key, label }) => (
        <ShiftSelect key={key} label={label} value={form.picks[key]} shifts={shifts} onChange={(id) => form.setPick(key, id)} />
      ))}
    </>
  );
}

function CycleFields({ form }: { form: Form }) {
  // Texto digitado fica à parte para o campo poder ser apagado; ao sair, volta ao ciclo real.
  const [typed, setTyped] = useState<string | null>(null);
  return (
    <div className="grid grid-cols-2 gap-3">
      <Field label="Início" htmlFor="schedule-start">
        <Input
          id="schedule-start"
          type="date"
          value={form.draft.startDate}
          onChange={(event) => form.setStart(event.target.value)}
        />
      </Field>
      <Field label="Ciclo (dias)" htmlFor="schedule-cycle">
        <Input
          id="schedule-cycle"
          type="number"
          min={1}
          max={28}
          value={typed ?? form.draft.cycleLength}
          onChange={(event) => {
            setTyped(event.target.value);
            form.setCycle(event.target.valueAsNumber);
          }}
          onBlur={() => setTyped(null)}
        />
      </Field>
    </div>
  );
}

function DayList({ form, shifts }: { form: Form; shifts: Shifts }) {
  const { draft } = form;
  return (
    <div className="grid grid-cols-2 gap-3">
      {draft.days.map((shiftId, index) => {
        const weekday = WEEKDAYS[isoWeekday(addDays(draft.startDate, index)) - 1];
        const label = `Dia ${index + 1} (${weekday})`;
        return (
          <Field key={index} label={label}>
            <Select value={shiftId ?? OFF} onValueChange={(value) => form.setDay(index, value === OFF ? null : value)}>
              <SelectTrigger aria-label={label}><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={OFF}>Folga</SelectItem>
                {shifts.map((shift) => <SelectItem key={shift.id} value={shift.id}>{shift.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </Field>
        );
      })}
    </div>
  );
}

function RemoveButton({ disabled, onConfirm }: { disabled: boolean; onConfirm: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" variant="outline" disabled={disabled} onClick={() => setOpen(true)}>
        Remover escala
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remover escala?</AlertDialogTitle>
            <AlertDialogDescription>A pessoa volta a seguir o turno do cadastro.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={onConfirm}>Remover</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
