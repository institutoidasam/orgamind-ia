import { useEffect, useMemo } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm, useWatch, type UseFormReturn } from 'react-hook-form';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  authorizationLabel,
  toAuthorizationInput,
  todayInManaus,
  type AuthorizationChoice,
  type ContactAuthorization,
} from '@/features/people-record/authorization';
import { AuthorizationField } from '@/features/people-record/components/authorization-field';
import { ReasonField } from '@/features/people-record/components/reason-field';
import { RegistrationField } from '@/features/people-record/components/registration-field';
import { reasonSchema } from '@/features/people-record/reason';
import { usePermission } from '@/features/permissions/use-permission';
import { JobTitleField } from '@/features/users/components/job-title-field';
import { LevelSelect } from '@/features/users/components/level-select';
import { PhoneField } from '@/features/users/components/phone-field';
import { ShiftSelect } from '@/features/users/components/shift-select';
import { reportUserPhoneError } from '@/features/users/phone-errors';
import { formatPhoneBR } from '@/lib/format-phone';
import { useUpdateSectorPerson } from '../api';
import { toastSectorPeopleError } from '../error-messages';
import { isMaskedName, phoneText } from '../phone-text';
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

/** Autorização atual como escolha da tela; "cadastro anterior" não tem origem a marcar, então fica `null`. */
function authorizationChoiceOf(authorization: ContactAuthorization): AuthorizationChoice | null {
  if (authorization.status === 'NAO_AUTORIZADO') return { status: 'NAO_AUTORIZADO' };
  const { source, note, date } = authorization;
  if (source === null || source === 'CADASTRO_ANTERIOR') return null;
  return { status: 'AUTORIZADO', source, ...(note ? { note } : {}), date: date ?? todayInManaus() };
}

/** Sem `telefone.ver_completo` o telefone gravado não é editável (B3): o campo parte vazio e o PATCH não leva `phone`. */
function initialValues(person: SectorPerson, canSeePhone: boolean): PersonFormInput {
  return {
    name: isMaskedName(person.name) ? '' : person.name,
    phone: canSeePhone && person.phoneE164 ? formatPhoneBR(person.phoneE164) : '',
    levelId: person.level?.id ?? null,
    jobTitle: person.jobTitle ?? '',
    shiftId: person.shift?.id ?? null,
    registration: person.registration ?? '',
    authorization: authorizationChoiceOf(person.contactAuthorization),
    reason: '',
  };
}

function changedIdentity(data: PersonFormInput, initial: PersonFormInput): UpdateSectorPersonInput {
  const name = (data.name ?? '').trim();
  return {
    ...(name !== initial.name ? { name } : {}),
    ...(data.phone && data.phone !== initial.phone ? { phone: data.phone } : {}),
  };
}

const choiceKey = (choice: AuthorizationChoice | null | undefined) => (choice ? JSON.stringify(toAuthorizationInput(choice)) : '');

/** Matrícula e autorização só vão quando mudaram; sem origem escolhida a autorização atual fica como está. */
function changedRecord(data: PersonFormInput, initial: PersonFormInput): UpdateSectorPersonInput {
  const registration = data.registration ?? '';
  const choice = data.authorization;
  return {
    ...(registration !== initial.registration ? { registration: registration || null } : {}),
    ...(choice && choiceKey(choice) !== choiceKey(initial.authorization) ? { contactAuthorization: toAuthorizationInput(choice) } : {}),
  };
}

function changedClassification(data: PersonFormInput, initial: PersonFormInput): UpdateSectorPersonInput {
  return {
    ...((data.levelId ?? null) !== initial.levelId ? { levelId: data.levelId ?? null } : {}),
    ...((data.jobTitle ?? '').trim() !== initial.jobTitle ? { jobTitle: data.jobTitle?.trim() || null } : {}),
    ...(data.shiftId && data.shiftId !== initial.shiftId ? { shiftId: data.shiftId } : {}),
  };
}

/** Só o que mudou vai no PATCH; pessoa com acesso nunca leva nome, telefone, matrícula ou autorização (D16). */
function changedPayload(data: PersonFormInput, initial: PersonFormInput, full: boolean): UpdateSectorPersonInput {
  return {
    ...(full ? { ...changedIdentity(data, initial), ...changedRecord(data, initial) } : {}),
    ...changedClassification(data, initial),
  };
}

async function reportSubmitError(form: Form, error: unknown) {
  if (!(await reportUserPhoneError(form, error))) await toastSectorPeopleError(error);
}

function usePersonForm({ sectorId, person, onOpenChange }: Props) {
  const update = useUpdateSectorPerson(sectorId);
  const full = person.editable === 'full';
  const canSeePhone = usePermission('telefone.ver_completo');
  const phoneLocked = !canSeePhone && person.hasPhone;
  const initial = useMemo(() => initialValues(person, canSeePhone), [person, canSeePhone]);
  const form = useForm<PersonFormInput>({ resolver: zodResolver(personFormSchemaFor(person.editable, isMaskedName(person.name))) as never, defaultValues: initial });
  useEffect(() => form.reset(initial), [initial, form]);
  const submit = async (data: PersonFormInput) => {
    const payload = changedPayload(data, initial, full);
    if (Object.keys(payload).length === 0) return onOpenChange(false);
    // A4: editar pessoa do setor exige motivo; sem mudança não há o que justificar.
    const reason = reasonSchema.safeParse(data.reason ?? '');
    if (!reason.success) return form.setError('reason', { message: reason.error.issues[0].message });
    try {
      await update.mutateAsync({ userId: person.id, data: { ...payload, reason: reason.data } });
      toast.success('Pessoa atualizada.');
      onOpenChange(false);
    } catch (error) {
      await reportSubmitError(form, error);
    }
  };
  return { form, submit, pending: update.isPending, full, phoneLocked };
}

const PHONE_LOCKED_NOTE = 'Você não tem permissão para alterar o telefone já cadastrado.';
const PHONE_ACCESS_NOTE = 'Nome e telefone de quem tem acesso mudam em Usuários.';

/** Telefone só leitura: a máscara ou "—", nunca o número que a tela não recebeu. */
function ReadOnlyPhone({ person, note }: { person: SectorPerson; note: string }) {
  return (
    <div className="space-y-1">
      <Label htmlFor="person-phone">Telefone (WhatsApp)</Label>
      <Input id="person-phone" value={phoneText(person)} disabled readOnly />
      <p className="text-xs text-muted-foreground">{note}</p>
    </div>
  );
}

const MASKED_NAME_NOTE = 'O nome desta pessoa é o número de telefone. Informe o nome para substituir.';

/** Nome mascarado: campo vazio com a máscara no placeholder; vazio = não mexe no nome. */
function NameField({ form, person }: { form: Form; person: SectorPerson }) {
  const masked = isMaskedName(person.name);
  return (
    <div className="space-y-1">
      <Label htmlFor="person-name">Nome</Label>
      <Input id="person-name" placeholder={masked ? person.name : undefined} {...form.register('name')} />
      {masked && <p className="text-xs text-muted-foreground">{MASKED_NAME_NOTE}</p>}
      {form.formState.errors.name && <p className="text-xs text-destructive">{form.formState.errors.name.message}</p>}
    </div>
  );
}

type IdentityProps = { form: Form; person: SectorPerson; full: boolean; phoneLocked: boolean };

function IdentityFields({ form, person, full, phoneLocked }: IdentityProps) {
  if (full) {
    return (
      <>
        <NameField form={form} person={person} />
        {phoneLocked ? (
          <ReadOnlyPhone person={person} note={PHONE_LOCKED_NOTE} />
        ) : (
          <PhoneField id="person-phone" registration={form.register('phone')} error={form.formState.errors.phone?.message} />
        )}
        <RegistrationEdit form={form} />
        <AuthorizationEdit form={form} person={person} />
      </>
    );
  }
  return (
    <>
      <div className="space-y-1">
        <Label htmlFor="person-name">Nome</Label>
        <Input id="person-name" value={person.name} disabled readOnly />
      </div>
      <ReadOnlyPhone person={person} note={PHONE_ACCESS_NOTE} />
      <ReadOnlyRecord person={person} />
    </>
  );
}

function RegistrationEdit({ form }: { form: Form }) {
  const registration = useWatch({ control: form.control, name: 'registration' });
  return (
    <RegistrationField
      value={registration ?? ''}
      onChange={(value) => form.setValue('registration', value)}
      error={form.formState.errors.registration?.message}
    />
  );
}

/** Origem a marcar só quando houver; a mensagem de erro some assim que a escolha é corrigida. */
function AuthorizationEdit({ form, person }: { form: Form; person: SectorPerson }) {
  const choice = useWatch({ control: form.control, name: 'authorization' }) ?? null;
  const error = form.formState.errors.authorization?.message;
  return (
    <div className="space-y-2">
      {choice === null && (
        <p className="text-xs text-muted-foreground">Atual: {authorizationLabel(person.contactAuthorization)}. Escolha a origem para regularizar.</p>
      )}
      <AuthorizationField
        value={choice}
        error={error}
        onChange={(next) => form.setValue('authorization', next, { shouldValidate: Boolean(error) })}
      />
    </div>
  );
}

/** D16: pessoa com acesso muda matrícula e autorização em Usuários, nem o ADMIN muda aqui. */
function ReadOnlyRecord({ person }: { person: SectorPerson }) {
  return (
    <>
      <div className="space-y-1">
        <Label htmlFor="person-registration">Matrícula</Label>
        <Input id="person-registration" value={person.registration ?? '—'} disabled readOnly />
      </div>
      <div className="space-y-1">
        <Label htmlFor="person-authorization">Autorização de contato</Label>
        <Input id="person-authorization" value={authorizationLabel(person.contactAuthorization)} disabled readOnly />
        <p className="text-xs text-muted-foreground">Matrícula e autorização de quem tem acesso mudam em Usuários.</p>
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

function ReasonEdit({ form }: { form: Form }) {
  const reason = useWatch({ control: form.control, name: 'reason' });
  return (
    <ReasonField
      value={reason ?? ''}
      onChange={(value) => {
        form.setValue('reason', value);
        form.clearErrors('reason');
      }}
      error={form.formState.errors.reason?.message}
    />
  );
}

export function EditPersonDialog(props: Props) {
  const { form, submit, pending, full, phoneLocked } = usePersonForm(props);
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Editar pessoa</DialogTitle>
        </DialogHeader>
        {/* noValidate: a validação nativa (`max` da data) bloquearia o envio sem mostrar a nossa mensagem. */}
        <form onSubmit={form.handleSubmit(submit)} noValidate className="space-y-4 py-2">
          <IdentityFields form={form} person={props.person} full={full} phoneLocked={phoneLocked} />
          <ClassificationFields form={form} person={props.person} options={props.options} />
          <ReasonEdit form={form} />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => props.onOpenChange(false)}>Cancelar</Button>
            <Button type="submit" disabled={pending}>{pending ? 'Salvando...' : 'Salvar'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
