import { zodResolver } from '@hookform/resolvers/zod';
import { useForm, useWatch, type UseFormReturn } from 'react-hook-form';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toAuthorizationInput } from '@/features/people-record/authorization';
import { AuthorizationField } from '@/features/people-record/components/authorization-field';
import { RegistrationField } from '@/features/people-record/components/registration-field';
import { JobTitleField } from '@/features/users/components/job-title-field';
import { LevelSelect } from '@/features/users/components/level-select';
import { PhoneField } from '@/features/users/components/phone-field';
import { reportUserPhoneError } from '@/features/users/phone-errors';
import { useCreateSectorPerson } from '../api';
import { addedPeopleMessage, toastSectorPeopleError } from '../error-messages';
import { newPersonFormSchema, type CreateSectorPersonInput, type NewPersonFormInput, type SectorPeopleOptions } from '../schemas';
import { RequiredShiftSelect } from './shift-field';

export type AddTabProps = { sectorId: string; options: SectorPeopleOptions; onDone: () => void };

const EMPTY_PERSON: NewPersonFormInput = { name: '', phone: '', registration: '', authorization: null, levelId: null, jobTitle: '', shiftId: '' };

/** A2: a autorização é sempre escolhida (a validação já recusou `null`); matrícula vazia não vai no corpo. */
function toCreateInput({ authorization, registration, jobTitle, ...rest }: NewPersonFormInput): CreateSectorPersonInput | null {
  if (!authorization) return null;
  return { ...rest, ...(registration ? { registration } : {}), contactAuthorization: toAuthorizationInput(authorization), jobTitle: jobTitle || null };
}

type Form = UseFormReturn<NewPersonFormInput>;

function RegistrationInput({ form }: { form: Form }) {
  const registration = useWatch({ control: form.control, name: 'registration' });
  return (
    <RegistrationField
      value={registration}
      onChange={(value) => form.setValue('registration', value)}
      error={form.formState.errors.registration?.message}
    />
  );
}

/** O erro some assim que a escolha é corrigida: depois do primeiro erro, cada troca revalida. */
function AuthorizationInput({ form }: { form: Form }) {
  const authorization = useWatch({ control: form.control, name: 'authorization' });
  const error = form.formState.errors.authorization?.message;
  return (
    <AuthorizationField
      value={authorization}
      error={error}
      onChange={(next) => form.setValue('authorization', next, { shouldValidate: Boolean(error) })}
    />
  );
}

/** Pessoa nova entra sem acesso, neste setor, já com turno (Q3). */
export function NewPersonTab({ sectorId, options, onDone }: AddTabProps) {
  const create = useCreateSectorPerson(sectorId);
  const form = useForm<NewPersonFormInput>({ resolver: zodResolver(newPersonFormSchema) as never, defaultValues: EMPTY_PERSON });
  const levelId = useWatch({ control: form.control, name: 'levelId' });
  const shiftId = useWatch({ control: form.control, name: 'shiftId' });

  const submit = async (data: NewPersonFormInput) => {
    const input = toCreateInput(data);
    if (!input) return;
    try {
      await create.mutateAsync(input);
      toast.success(addedPeopleMessage(1));
      onDone();
    } catch (error) {
      if (!(await reportUserPhoneError(form, error))) await toastSectorPeopleError(error);
    }
  };

  return (
    <form onSubmit={form.handleSubmit(submit)} noValidate className="space-y-4">
      <div className="space-y-1">
        <Label htmlFor="new-person-name">Nome</Label>
        <Input id="new-person-name" {...form.register('name')} />
        {form.formState.errors.name && <p className="text-xs text-destructive">{form.formState.errors.name.message}</p>}
      </div>
      <PhoneField id="new-person-phone" registration={form.register('phone')} error={form.formState.errors.phone?.message} />
      <RegistrationInput form={form} />
      <LevelSelect value={levelId} onChange={(value) => form.setValue('levelId', value)} levels={options.levels} />
      <JobTitleField id="new-person-job-title" registration={form.register('jobTitle')} error={form.formState.errors.jobTitle?.message} />
      <RequiredShiftSelect value={shiftId} onChange={(value) => form.setValue('shiftId', value)} shifts={options.shifts} />
      <AuthorizationInput form={form} />
      <p className="text-xs text-muted-foreground">Entra sem acesso ao sistema; o acesso é dado depois, em Usuários.</p>
      <div className="flex justify-end">
        <Button type="submit" disabled={!shiftId || create.isPending}>{create.isPending ? 'Adicionando...' : 'Adicionar'}</Button>
      </div>
    </form>
  );
}
