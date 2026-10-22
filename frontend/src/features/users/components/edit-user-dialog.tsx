import { useEffect, useMemo } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm, useWatch, type UseFormReturn } from "react-hook-form";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useSectors } from "@/features/internal-admin/api";
import { useShifts } from "@/features/shifts/api";
import { formatPhoneBR } from "@/lib/format-phone";
import { useActiveLevels, useUpdateUser } from "../api";
import { editableUserPayload, type ChangedUserFields } from "../edit-user-payload";
import { reportUserSubmitError } from "../submit-error";
import { editUserSchemaFor, type EditUserInput, type UserSummary } from "../schemas";
import { JobTitleField } from "./job-title-field";
import { LevelSelect } from "./level-select";
import { PhoneField } from "./phone-field";
import { RoleSelect, SectorSelect } from "./role-sector-selects";
import { ShiftSelect } from "./shift-select";

type Props = { user: UserSummary; open: boolean; onOpenChange: (open: boolean) => void; isSelf: boolean };
type Form = UseFormReturn<EditUserInput>;

export function EditUserDialog({ user, open, onOpenChange, isSelf }: Props) {
  const state = useEditUserForm(user, isSelf, onOpenChange);
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent><DialogHeader><DialogTitle>Editar usuário</DialogTitle></DialogHeader><EditUserForm state={state} user={user} isSelf={isSelf} onCancel={() => onOpenChange(false)} /></DialogContent></Dialog>;
}

function changedFields(data: EditUserInput, user: UserSummary, initialPhone: string): ChangedUserFields {
  return {
    phone: (data.phone ?? "") !== initialPhone,
    shiftId: (data.shiftId ?? null) !== (user.shiftId ?? null),
    jobTitle: (data.jobTitle ?? "").trim() !== (user.jobTitle ?? ""),
    levelId: (data.levelId ?? null) !== (user.levelId ?? null),
  };
}

function useEditUserForm(user: UserSummary, isSelf: boolean, onOpenChange: Props["onOpenChange"]) {
  const update = useUpdateUser();
  const sectors = useSectors(true);
  const shifts = useShifts();
  const levels = useActiveLevels();
  const schema = useMemo(() => editUserSchemaFor(Boolean(user.phoneE164), user.hasAccess), [user.phoneE164, user.hasAccess]);
  const form = useForm<EditUserInput>({ resolver: zodResolver(schema) as never });
  const initialPhone = user.phoneE164 ? formatPhoneBR(user.phoneE164) : "";
  useEffect(() => form.reset({ name: user.name ?? "", phone: initialPhone, role: user.role, sectorId: user.sectorId, shiftId: user.shiftId, jobTitle: user.jobTitle ?? "", levelId: user.levelId, isActive: user.isActive }), [user, initialPhone, form]);
  const submit = async (data: EditUserInput) => {
    try {
      await update.mutateAsync({ id: user.id, data: editableUserPayload(data, isSelf, changedFields(data, user, initialPhone), user.hasAccess) });
      toast.success("Usuário atualizado.");
      onOpenChange(false);
    } catch (error) {
      await reportUserSubmitError(form, error);
    }
  };
  return { form, isActive: useWatch({ control: form.control, name: "isActive" }), pending: update.isPending, role: useWatch({ control: form.control, name: "role" }), sectorId: useWatch({ control: form.control, name: "sectorId" }), shiftId: useWatch({ control: form.control, name: "shiftId" }), levelId: useWatch({ control: form.control, name: "levelId" }), sectors: sectors.data?.items ?? [], shifts: shifts.data ?? [], levels: levels.data ?? [], submit };
}

function EditUserForm({ state, user, isSelf, onCancel }: { state: State; user: UserSummary; isSelf: boolean; onCancel: () => void }) {
  return <form onSubmit={state.form.handleSubmit(state.submit)} className="space-y-4 py-2"><UserIdentity form={state.form} user={user} /><RoleAndSectorFields state={state} user={user} isSelf={isSelf} /><AccessField form={state.form} isActive={state.isActive} disabled={isSelf} hasAccess={user.hasAccess} /><DialogFooter><Button type="button" variant="ghost" onClick={onCancel}>Cancelar</Button><Button type="submit" disabled={state.pending}>{state.pending ? "Salvando..." : "Salvar"}</Button></DialogFooter></form>;
}

function UserIdentity({ form, user }: { form: Form; user: UserSummary }) {
  return <>{user.email && <div className="space-y-1"><Label>Email (não editável)</Label><Input value={user.email} disabled /></div>}<div className="space-y-1"><Label htmlFor="edit-name">Nome</Label><Input id="edit-name" {...form.register("name")} />{form.formState.errors.name && <p className="text-xs text-destructive">{form.formState.errors.name.message}</p>}</div><PhoneField id="edit-phone" registration={form.register("phone")} error={form.formState.errors.phone?.message} /></>;
}

function RoleAndSectorFields({ state, user, isSelf }: { state: State; user: UserSummary; isSelf: boolean }) {
  const { form } = state;
  return <>{user.hasAccess && <div className="space-y-1"><RoleSelect value={state.role ?? user.role} onChange={(value) => form.setValue("role", value)} disabled={isSelf} />{isSelf && <p className="text-xs" style={{ color: "var(--foreground-muted)" }}>Você não pode alterar seu próprio perfil.</p>}</div>}<div className="space-y-1"><SectorSelect value={state.sectorId ?? null} onChange={(value) => form.setValue("sectorId", value)} sectors={state.sectors} disabled={isSelf} /></div><ShiftSelect value={state.shiftId ?? null} onChange={(value) => form.setValue("shiftId", value)} shifts={state.shifts} /><LevelSelect value={state.levelId ?? null} onChange={(value) => form.setValue("levelId", value)} levels={state.levels} current={user.level} /><JobTitleField id="edit-job-title" registration={form.register("jobTitle")} error={form.formState.errors.jobTitle?.message} /></>;
}

function AccessField({ form, isActive, disabled, hasAccess }: { form: Form; isActive: boolean | undefined; disabled: boolean; hasAccess: boolean }) {
  const [label, on, off] = hasAccess ? ["Acesso", "Ativo", "Inativo"] : ["Situação", "Ativa", "Inativa"];
  return <div className="space-y-1"><Label htmlFor="edit-active">{label}</Label><Select value={isActive === false ? "inactive" : "active"} onValueChange={(value) => form.setValue("isActive", value === "active")} disabled={disabled}><SelectTrigger id="edit-active"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="active">{on}</SelectItem><SelectItem value="inactive">{off}</SelectItem></SelectContent></Select>{hasAccess && <p className="text-xs text-muted-foreground">Acesso inativo encerra sessões existentes.</p>}</div>;
}

type State = ReturnType<typeof useEditUserForm>;
