import { useState, type ReactNode } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { formatDayMonth } from '@/lib/civil-date';
import { useCreateException, useDeleteException } from '../api';
import { describeScheduleError } from '../error-messages';
import {
  draftToInput, KIND_OPTIONS, needsSector, needsShift, newDraft, validateDraft,
  type DraftErrors, type ExceptionDraft,
} from '../exception-form';
import type { ScheduleOptions, StaffExceptionKind } from '../schemas';

/** Pessoa e dia da célula clicada; `exceptionId` preenchido = há exceção a remover. */
export type ExceptionTarget = { userId: string; name: string; date: string; exceptionId: string | null };

type Props = {
  target: ExceptionTarget;
  options: Pick<ScheduleOptions, 'sectors' | 'shifts'>;
  onClose: () => void;
};

const REMOVE_FALLBACK = 'Não foi possível remover a exceção.';

function useExceptionForm(target: ExceptionTarget, onClose: () => void) {
  const create = useCreateException();
  const remove = useDeleteException();
  const [draft, setDraft] = useState<ExceptionDraft>(() => newDraft(target.date));
  const [errors, setErrors] = useState<DraftErrors>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [adjusted, setAdjusted] = useState(0);
  const set = <K extends keyof ExceptionDraft>(key: K, value: ExceptionDraft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));
  const run = async (request: () => Promise<void>, fallback?: string) => {
    setServerError(null);
    try {
      await request();
    } catch (error) {
      setServerError((await describeScheduleError(error, fallback)).message);
    }
  };
  const submit = async () => {
    const found = validateDraft(draft);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    await run(async () => {
      const result = await create.mutateAsync({ userId: target.userId, body: draftToInput(draft) });
      if (result.adjusted > 0) setAdjusted(result.adjusted);
      else onClose();
    });
  };
  const removeException = () =>
    run(async () => {
      await remove.mutateAsync(target.exceptionId as string);
      onClose();
    }, REMOVE_FALLBACK);
  return {
    draft, set, errors, serverError, adjusted, submit, removeException,
    pending: create.isPending || remove.isPending,
  };
}

type Form = ReturnType<typeof useExceptionForm>;

export function ExceptionDialog({ target, options, onClose }: Props) {
  const form = useExceptionForm(target, onClose);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Exceção na escala</DialogTitle>
          <DialogDescription>{`${target.name} · ${formatDayMonth(target.date)}`}</DialogDescription>
        </DialogHeader>
        {form.adjusted > 0 ? (
          <AdjustedNotice count={form.adjusted} onClose={onClose} />
        ) : (
          <ExceptionForm form={form} hasException={target.exceptionId !== null} options={options} onClose={onClose} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function AdjustedNotice({ count, onClose }: { count: number; onClose: () => void }) {
  return (
    <div className="space-y-4 py-2">
      <Alert>
        <AlertDescription>
          {`${count} exceção(ões) anterior(es) foram recortadas ou substituídas nesses dias.`}
        </AlertDescription>
      </Alert>
      <DialogFooter>
        <Button type="button" onClick={onClose}>Fechar</Button>
      </DialogFooter>
    </div>
  );
}

type FormProps = { form: Form; hasException: boolean; options: Props['options']; onClose: () => void };

function ExceptionForm({ form, hasException, options, onClose }: FormProps) {
  return (
    <form
      onSubmit={(event) => { event.preventDefault(); void form.submit(); }}
      className="space-y-4 py-2"
    >
      <KindField form={form} />
      <PeriodFields form={form} />
      <TargetFields form={form} options={options} />
      <Field label="Observação" htmlFor="exception-note" error={form.errors.note}>
        <Input
          id="exception-note"
          placeholder="Ex.: atestado, feriado"
          value={form.draft.note}
          onChange={(event) => form.set('note', event.target.value)}
        />
      </Field>
      {form.serverError && <p role="alert" className="text-sm text-destructive">{form.serverError}</p>}
      <DialogFooter>
        {hasException && (
          <Button type="button" variant="outline" disabled={form.pending} onClick={form.removeException}>
            Remover exceção
          </Button>
        )}
        <Button type="button" variant="ghost" onClick={onClose}>Cancelar</Button>
        <Button type="submit" disabled={form.pending}>{form.pending ? 'Salvando...' : 'Salvar'}</Button>
      </DialogFooter>
    </form>
  );
}

function Field({ label, htmlFor, error, children }: { label: string; htmlFor?: string; error?: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

function KindField({ form }: { form: Form }) {
  return (
    <Field label="Tipo">
      <Select value={form.draft.kind} onValueChange={(value) => form.set('kind', value as StaffExceptionKind)}>
        <SelectTrigger aria-label="Tipo"><SelectValue /></SelectTrigger>
        <SelectContent>
          {KIND_OPTIONS.map((kind) => <SelectItem key={kind.value} value={kind.value}>{kind.label}</SelectItem>)}
        </SelectContent>
      </Select>
    </Field>
  );
}

function PeriodFields({ form }: { form: Form }) {
  return (
    <div className="grid grid-cols-2 gap-3">
      <Field label="De" htmlFor="exception-start">
        <Input
          id="exception-start"
          type="date"
          value={form.draft.startDate}
          onChange={(event) => form.set('startDate', event.target.value)}
        />
      </Field>
      <Field label="Até" htmlFor="exception-end" error={form.errors.endDate}>
        <Input
          id="exception-end"
          type="date"
          value={form.draft.endDate}
          onChange={(event) => form.set('endDate', event.target.value)}
        />
      </Field>
    </div>
  );
}

type Choice = { id: string; name: string };

function ChoiceField(props: {
  label: string; value: string; choices: Choice[]; error?: string; onChange: (id: string) => void;
}) {
  return (
    <Field label={props.label} error={props.error}>
      <Select value={props.value} onValueChange={props.onChange}>
        <SelectTrigger aria-label={props.label}><SelectValue placeholder="Escolha" /></SelectTrigger>
        <SelectContent>
          {props.choices.map((choice) => <SelectItem key={choice.id} value={choice.id}>{choice.name}</SelectItem>)}
        </SelectContent>
      </Select>
    </Field>
  );
}

function TargetFields({ form, options }: { form: Form; options: Props['options'] }) {
  const { draft, errors } = form;
  return (
    <>
      {needsSector(draft.kind) && (
        <ChoiceField
          label="Setor de destino"
          value={draft.sectorId}
          choices={options.sectors}
          error={errors.sectorId}
          onChange={(id) => form.set('sectorId', id)}
        />
      )}
      {needsShift(draft.kind) && (
        <ChoiceField
          label="Turno"
          value={draft.shiftId}
          choices={options.shifts}
          error={errors.shiftId}
          onChange={(id) => form.set('shiftId', id)}
        />
      )}
    </>
  );
}
