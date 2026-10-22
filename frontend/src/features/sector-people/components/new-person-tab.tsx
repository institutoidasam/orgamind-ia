import { zodResolver } from '@hookform/resolvers/zod';
import { useForm, useWatch } from 'react-hook-form';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { JobTitleField } from '@/features/users/components/job-title-field';
import { LevelSelect } from '@/features/users/components/level-select';
import { PhoneField } from '@/features/users/components/phone-field';
import { reportUserPhoneError } from '@/features/users/phone-errors';
import { useCreateSectorPerson } from '../api';
import { addedPeopleMessage, toastSectorPeopleError } from '../error-messages';
import { newPersonFormSchema, type NewPersonFormInput, type SectorPeopleOptions } from '../schemas';
import { RequiredShiftSelect } from './shift-field';

export type AddTabProps = { sectorId: string; options: SectorPeopleOptions; onDone: () => void };

const EMPTY_PERSON: NewPersonFormInput = { name: '', phone: '', levelId: null, jobTitle: '', shiftId: '' };

/** Pessoa nova entra sem acesso, neste setor, já com turno (Q3). */
export function NewPersonTab({ sectorId, options, onDone }: AddTabProps) {
  const create = useCreateSectorPerson(sectorId);
  const form = useForm<NewPersonFormInput>({ resolver: zodResolver(newPersonFormSchema) as never, defaultValues: EMPTY_PERSON });
  const levelId = useWatch({ control: form.control, name: 'levelId' });
  const shiftId = useWatch({ control: form.control, name: 'shiftId' });

  const submit = async (data: NewPersonFormInput) => {
    try {
      await create.mutateAsync({ ...data, jobTitle: data.jobTitle || null });
      toast.success(addedPeopleMessage(1));
      onDone();
    } catch (error) {
      if (!(await reportUserPhoneError(form, error))) await toastSectorPeopleError(error);
    }
  };

  return (
    <form onSubmit={form.handleSubmit(submit)} className="space-y-4">
      <div className="space-y-1">
        <Label htmlFor="new-person-name">Nome</Label>
        <Input id="new-person-name" {...form.register('name')} />
        {form.formState.errors.name && <p className="text-xs text-destructive">{form.formState.errors.name.message}</p>}
      </div>
      <PhoneField id="new-person-phone" registration={form.register('phone')} error={form.formState.errors.phone?.message} />
      <LevelSelect value={levelId} onChange={(value) => form.setValue('levelId', value)} levels={options.levels} />
      <JobTitleField id="new-person-job-title" registration={form.register('jobTitle')} error={form.formState.errors.jobTitle?.message} />
      <RequiredShiftSelect value={shiftId} onChange={(value) => form.setValue('shiftId', value)} shifts={options.shifts} />
      <p className="text-xs text-muted-foreground">Entra sem acesso ao sistema; o acesso é dado depois, em Usuários.</p>
      <div className="flex justify-end">
        <Button type="submit" disabled={!shiftId || create.isPending}>{create.isPending ? 'Adicionando...' : 'Adicionar'}</Button>
      </div>
    </form>
  );
}
