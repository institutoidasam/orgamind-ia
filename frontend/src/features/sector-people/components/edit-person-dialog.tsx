import { useEffect, useMemo } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm, useWatch, type UseFormReturn } from 'react-hook-form';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { JobTitleField } from '@/features/users/components/job-title-field';
import { LevelSelect } from '@/features/users/components/level-select';
import { PhoneField } from '@/features/users/components/phone-field';
import { ShiftSelect } from '@/features/users/components/shift-select';
import { reportUserPhoneError } from '@/features/users/phone-errors';
import { formatPhoneBR } from '@/lib/format-phone';
import { useUpdateSectorPerson } from '../api';
import { toastSectorPeopleError } from '../error-messages';
import {
  personFormSchemaFor,
  type PersonFormInput,
  type SectorPeopleOptions,
  type SectorPerson,
  type UpdateSectorPersonInput,
} from '../schemas';
import { RequiredShiftSelect } from './shift-field';

type Props = {
  sectorId: string;
  person: SectorPerson;
  options: SectorPeopleOptions;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};
type Form = UseFormReturn<PersonFormInput>;

function initialValues(person: SectorPerson): PersonFormInput {
  return {
    name: person.name,
    phone: person.phoneE164 ? formatPhoneBR(person.phoneE164) : '',
    levelId: person.level?.id ?? null,
    jobTitle: person.jobTitle ?? '',
    shiftId: person.shift?.id ?? null,
  };
}

function changedIdentity(data: PersonFormInput, initial: PersonFormInput): UpdateSectorPersonInput {
  const name = (data.name ?? '').trim();
  return {
    ...(name !== initial.name ? { name } : {}),
    ...(data.phone && data.phone !== initial.phone ? { phone: data.phone } : {}),
  };
}

function changedClassification(data: PersonFormInput, initial: PersonFormInput): UpdateSectorPersonInput {
  return {
    ...((data.levelId ?? null) !== initial.levelId ? { levelId: data.levelId ?? null } : {}),
    ...((data.jobTitle ?? '').trim() !== initial.jobTitle ? { jobTitle: data.jobTitle?.trim() || null } : {}),
    ...(data.shiftId && data.shiftId !== initial.shiftId ? { shiftId: data.shiftId } : {}),
  };
}

/** Só o que mudou vai no PATCH; pessoa com acesso nunca leva nome ou telefone. */
function changedPayload(data: PersonFormInput, initial: PersonFormInput, full: boolean): UpdateSectorPersonInput {
  return { ...(full ? changedIdentity(data, initial) : {}), ...changedClassification(data, initial) };
}

async function reportSubmitError(form: Form, error: unknown) {
  if (!(await reportUserPhoneError(form, error))) await toastSectorPeopleError(error);
}

function usePersonForm({ sectorId, person, onOpenChange }: Props) {
  const update = useUpdateSectorPerson(sectorId);
  const full = person.editable === 'full';
  const initial = useMemo(() => initialValues(person), [person]);
  const form = useForm<PersonFormInput>({ resolver: zodResolver(personFormSchemaFor(person.editable)) as never, defaultValues: initial });
  useEffect(() => form.reset(initial), [initial, form]);
  const submit = async (data: PersonFormInput) => {
    const payload = changedPayload(data, initial, full);
    if (Object.keys(payload).length === 0) return onOpenChange(false);
    try {
      await update.mutateAsync({ userId: person.id, data: payload });
      toast.success('Pessoa atualizada.');
      onOpenChange(false);
    } catch (error) {
      await reportSubmitError(form, error);
    }
  };
  return { form, submit, pending: update.isPending, full };
}

function IdentityFields({ form, person, full }: { form: Form; person: SectorPerson; full: boolean }) {
  if (full) {
    return (
      <>
        <div className="space-y-1">
          <Label htmlFor="person-name">Nome</Label>
          <Input id="person-name" {...form.register('name')} />
          {form.formState.errors.name && <p className="text-xs text-destructive">{form.formState.errors.name.message}</p>}
        </div>
        <PhoneField id="person-phone" registration={form.register('phone')} error={form.formState.errors.phone?.message} />
      </>
    );
  }
  return (
    <>
      <div className="space-y-1">
        <Label htmlFor="person-name">Nome</Label>
        <Input id="person-name" value={person.name} disabled readOnly />
      </div>
      <div className="space-y-1">
        <Label htmlFor="person-phone">Telefone (WhatsApp)</Label>
        <Input id="person-phone" value={formatPhoneBR(person.phoneE164)} disabled readOnly />
        <p className="text-xs text-muted-foreground">Nome e telefone de quem tem acesso mudam em Usuários.</p>
      </div>
    </>
  );
}

function ShiftField({ form, person, options }: { form: Form; person: SectorPerson; options: SectorPeopleOptions }) {
  const shiftId = useWatch({ control: form.control, name: 'shiftId' });
  const shifts = [...options.shifts, ...(person.shift ? [{ ...person.shift, isActive: false }] : [])]
    .filter((shift, index, all) => all.findIndex((other) => other.id === shift.id) === index);
  // O PATCH não aceita shiftId null: quem já tem turno só troca de turno, nunca volta a "Sem turno".
  if (person.shift) {
    const labelled = shifts.map((shift) => ({ id: shift.id, name: 'isActive' in shift && shift.isActive === false ? `${shift.name} (inativo)` : shift.name }));
    return <RequiredShiftSelect value={shiftId ?? ''} onChange={(value) => form.setValue('shiftId', value)} shifts={labelled} />;
  }
  // ShiftSelect só usa id e nome; o horário não vem nesta resposta.
  const withTimes = shifts.map((shift) => ({ startTime: '', endTime: '', ...shift }));
  return <ShiftSelect value={shiftId ?? null} onChange={(value) => form.setValue('shiftId', value)} shifts={withTimes} />;
}

function ClassificationFields({ form, person, options }: { form: Form; person: SectorPerson; options: SectorPeopleOptions }) {
  const levelId = useWatch({ control: form.control, name: 'levelId' });
  return (
    <>
      <LevelSelect value={levelId ?? null} onChange={(value) => form.setValue('levelId', value)} levels={options.levels} current={person.level} />
      <JobTitleField id="person-job-title" registration={form.register('jobTitle')} error={form.formState.errors.jobTitle?.message} />
      <ShiftField form={form} person={person} options={options} />
    </>
  );
}

export function EditPersonDialog(props: Props) {
  const { form, submit, pending, full } = usePersonForm(props);
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Editar pessoa</DialogTitle>
        </DialogHeader>
        <form onSubmit={form.handleSubmit(submit)} className="space-y-4 py-2">
          <IdentityFields form={form} person={props.person} full={full} />
          <ClassificationFields form={form} person={props.person} options={props.options} />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => props.onOpenChange(false)}>Cancelar</Button>
            <Button type="submit" disabled={pending}>{pending ? 'Salvando...' : 'Salvar'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
