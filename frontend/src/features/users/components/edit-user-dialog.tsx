import { useEffect, useMemo } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm, useWatch, type UseFormReturn } from "react-hook-form";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authorizationLabel, type AuthorizationChoice } from "@/features/people-record/authorization";
import { AuthorizationField } from "@/features/people-record/components/authorization-field";
import { ReasonField } from "@/features/people-record/components/reason-field";
import { RegistrationField } from "@/features/people-record/components/registration-field";
import { useSectors } from "@/features/internal-admin/api";
import { useShifts } from "@/features/shifts/api";
import { formatPhoneBR } from "@/lib/format-phone";
import { useActiveLevels, useUpdateUser } from "../api";
import { authorizationChanged, authorizationChoiceOf, editableUserPayload, type ChangedUserFields } from "../edit-user-payload";
import { reportUserSubmitError } from "../submit-error";
import { editUserSchemaFor, type EditUserFormValues, type UserSummary } from "../schemas";
import { JobTitleField } from "./job-title-field";
import { LevelSelect } from "./level-select";
import { PhoneField } from "./phone-field";
import { RoleSelect, SectorSelect } from "./role-sector-selects";
import { ShiftSelect } from "./shift-select";

type Props = { user: UserSummary; open: boolean; onOpenChange: (open: boolean) => void; isSelf: boolean };
type Form = UseFormReturn<EditUserFormValues>;

export function EditUserDialog({ user, open, onOpenChange, isSelf }: Props) {
  const state = useEditUserForm(user, isSelf, onOpenChange);
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="max-h-[90vh] overflow-y-auto"><DialogHeader><DialogTitle>Editar usuário</DialogTitle></DialogHeader><EditUserForm state={state} user={user} isSelf={isSelf} onCancel={() => onOpenChange(false)} /></DialogContent></Dialog>;
}

type Initial = { phone: string; authorization: ReturnType<typeof authorizationChoiceOf> };

function changedFields(data: EditUserFormValues, user: UserSummary, initial: Initial): ChangedUserFields {
  return {
    phone: (data.phone ?? "") !== initial.phone,
    shiftId: (data.shiftId ?? null) !== (user.shiftId ?? null),
    jobTitle: (data.jobTitle ?? "").trim() !== (user.jobTitle ?? ""),
    levelId: (data.levelId ?? null) !== (user.levelId ?? null),
    ...changedRecord(data, user, initial),
  };
}

function changedRecord(data: EditUserFormValues, user: UserSummary, initial: Initial): ChangedUserFields {
  return {
    registration: (data.registration ?? "").trim() !== (user.registration ?? ""),
    authorization: authorizationChanged(data.authorization ?? null, initial.authorization),
  };
}

function useEditUserForm(user: UserSummary, isSelf: boolean, onOpenChange: Props["onOpenChange"]) {
  const update = useUpdateUser();
  const sectors = useSectors(true);
  const shifts = useShifts();
  const levels = useActiveLevels();
  const schema = useMemo(() => editUserSchemaFor(Boolean(user.phoneE164), user.hasAccess), [user.phoneE164, user.hasAccess]);
  const form = useForm<EditUserFormValues>({ resolver: zodResolver(schema) as never });
  const phone = user.phoneE164 ? formatPhoneBR(user.phoneE164) : "";
  const authorization = useMemo(() => authorizationChoiceOf(user.contactAuthorization), [user.contactAuthorization]);
  useEffect(() => form.reset({ name: user.name ?? "", phone, role: user.role, sectorId: user.sectorId, shiftId: user.shiftId, jobTitle: user.jobTitle ?? "", registration: user.registration ?? "", levelId: user.levelId, authorization, reason: "" }), [user, phone, authorization, form]);
  const submit = async (data: EditUserFormValues) => {
    try {
      await update.mutateAsync({ id: user.id, data: editableUserPayload(data, isSelf, changedFields(data, user, { phone, authorization }), user.hasAccess) });
      toast.success("Usuário atualizado.");
      onOpenChange(false);
    } catch (error) {
      await reportUserSubmitError(form, error);
    }
  };
  return { form, pending: update.isPending, role: useWatch({ control: form.control, name: "role" }), sectorId: useWatch({ control: form.control, name: "sectorId" }), shiftId: useWatch({ control: form.control, name: "shiftId" }), levelId: useWatch({ control: form.control, name: "levelId" }), sectors: sectors.data?.items ?? [], shifts: shifts.data ?? [], levels: levels.data ?? [], submit };
}

function EditUserForm({ state, user, isSelf, onCancel }: { state: State; user: UserSummary; isSelf: boolean; onCancel: () => void }) {
  return <form onSubmit={state.form.handleSubmit(state.submit)} noValidate className="space-y-4 py-2"><UserIdentity form={state.form} user={user} /><RoleAndSectorFields state={state} user={user} isSelf={isSelf} /><RecordFields form={state.form} user={user} /><DialogFooter><Button type="button" variant="ghost" onClick={onCancel}>Cancelar</Button><Button type="submit" disabled={state.pending}>{state.pending ? "Salvando..." : "Salvar"}</Button></DialogFooter></form>;
}

function UserIdentity({ form, user }: { form: Form; user: UserSummary }) {
  return <>{user.email && <div className="space-y-1"><Label>Email (não editável)</Label><Input value={user.email} disabled /></div>}<div className="space-y-1"><Label htmlFor="edit-name">Nome</Label><Input id="edit-name" {...form.register("name")} />{form.formState.errors.name && <p className="text-xs text-destructive">{form.formState.errors.name.message}</p>}</div><PhoneField id="edit-phone" registration={form.register("phone")} error={form.formState.errors.phone?.message} /><RegistrationInput form={form} /></>;
}

function RoleAndSectorFields({ state, user, isSelf }: { state: State; user: UserSummary; isSelf: boolean }) {
  const { form } = state;
  return <>{user.hasAccess && <div className="space-y-1"><RoleSelect value={state.role ?? user.role} onChange={(value) => form.setValue("role", value)} disabled={isSelf} />{isSelf && <p className="text-xs" style={{ color: "var(--foreground-muted)" }}>Você não pode alterar seu próprio perfil.</p>}</div>}<div className="space-y-1"><SectorSelect value={state.sectorId ?? null} onChange={(value) => form.setValue("sectorId", value)} sectors={state.sectors} disabled={isSelf} /></div><ShiftSelect value={state.shiftId ?? null} onChange={(value) => form.setValue("shiftId", value)} shifts={state.shifts} /><LevelSelect value={state.levelId ?? null} onChange={(value) => form.setValue("levelId", value)} levels={state.levels} current={user.level} /><JobTitleField id="edit-job-title" registration={form.register("jobTitle")} error={form.formState.errors.jobTitle?.message} /></>;
}

/** Atualiza o campo e, depois do primeiro envio, revalida só ele (o erro some ao corrigir). */
function fieldSetter(form: Form) {
  const revalidate = { shouldValidate: form.formState.isSubmitted };
  return {
    registration: (value: string) => form.setValue("registration", value, revalidate),
    authorization: (value: AuthorizationChoice) => form.setValue("authorization", value, revalidate),
    reason: (value: string) => form.setValue("reason", value, revalidate),
  };
}

function RegistrationInput({ form }: { form: Form }) {
  const value = useWatch({ control: form.control, name: "registration" });
  return <RegistrationField value={value ?? ""} onChange={fieldSetter(form).registration} error={form.formState.errors.registration?.message} />;
}

/** Autorização atual por extenso e, abaixo, o campo para registrar outra; sem escolha nova, nada muda. */
function RecordFields({ form, user }: { form: Form; user: UserSummary }) {
  const authorization = useWatch({ control: form.control, name: "authorization" });
  const reason = useWatch({ control: form.control, name: "reason" });
  const setter = fieldSetter(form);
  const { errors } = form.formState;
  return <><div className="space-y-2">{user.contactAuthorization && <p className="text-sm">Autorização atual: {authorizationLabel(user.contactAuthorization)}</p>}<AuthorizationField value={authorization ?? null} onChange={setter.authorization} error={errors.authorization?.message} /></div><ReasonField value={reason ?? ""} onChange={setter.reason} error={errors.reason?.message} /></>;
}

type State = ReturnType<typeof useEditUserForm>;
