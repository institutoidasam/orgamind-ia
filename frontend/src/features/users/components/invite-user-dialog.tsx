import { useEffect, useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm, useWatch, type UseFormReturn } from "react-hook-form";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useSectors } from "@/features/internal-admin/api";
import { useShifts } from "@/features/shifts/api";
import { useActiveLevels, useInviteUser } from "../api";
import { invitePayload } from "../invite-payload";
import { reportUserSubmitError } from "../submit-error";
import { inviteUserSchema, type InviteUserOutput } from "../schemas";
import { AccessSelect } from "./access-select";
import { JobTitleField } from "./job-title-field";
import { LevelSelect } from "./level-select";
import { PhoneField } from "./phone-field";
import { RoleSelect, SectorSelect } from "./role-sector-selects";
import { ShiftSelect } from "./shift-select";
import { TemporaryPasswordModal } from "./temporary-password-modal";

type Props = { open: boolean; onOpenChange: (open: boolean) => void };
type Form = UseFormReturn<InviteUserOutput>;
const EMPTY_INVITE: InviteUserOutput = { hasAccess: true, email: "", name: "", phone: "", role: "OPERATOR", sectorId: null, shiftId: null, jobTitle: "", levelId: null };

export function InviteUserDialog({ open, onOpenChange }: Props) {
  const [tmpPwd, setTmpPwd] = useState<string | null>(null);
  const state = useInviteForm(open, onOpenChange, setTmpPwd);
  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogHeader><DialogTitle>Cadastrar usuário</DialogTitle></DialogHeader>
          <InviteForm state={state} onCancel={() => onOpenChange(false)} />
        </DialogContent>
      </Dialog>
      {tmpPwd && <TemporaryPasswordModal password={tmpPwd} onClose={() => setTmpPwd(null)} />}
    </>
  );
}

function useField<K extends keyof InviteUserOutput>(form: Form, name: K) {
  return useWatch({ control: form.control, name });
}

function useInviteForm(open: boolean, onOpenChange: Props["onOpenChange"], setTmpPwd: (password: string) => void) {
  const invite = useInviteUser();
  const sectors = useSectors(true);
  const shifts = useShifts();
  const levels = useActiveLevels();
  const form = useForm<InviteUserOutput>({ resolver: zodResolver(inviteUserSchema) as never, defaultValues: EMPTY_INVITE });
  useEffect(() => { if (open) form.reset(EMPTY_INVITE); }, [open, form]);
  const submit = async (data: InviteUserOutput) => {
    try {
      const result = await invite.mutateAsync(invitePayload(data));
      if (result.temporaryPassword) setTmpPwd(result.temporaryPassword);
      form.reset(EMPTY_INVITE);
      onOpenChange(false);
    } catch (error) {
      await reportUserSubmitError(form, error);
    }
  };
  return {
    form,
    pending: invite.isPending,
    hasAccess: useField(form, "hasAccess") !== false,
    role: useField(form, "role"),
    sectorId: useField(form, "sectorId"),
    shiftId: useField(form, "shiftId"),
    levelId: useField(form, "levelId"),
    sectors: sectors.data?.items ?? [],
    shifts: shifts.data ?? [],
    levels: levels.data ?? [],
    submit,
  };
}

function InviteForm({ state, onCancel }: { state: State; onCancel: () => void }) {
  return (
    <form onSubmit={state.form.handleSubmit(state.submit)} className="space-y-4 py-2">
      <AccessSelect value={state.hasAccess} onChange={(value) => state.form.setValue("hasAccess", value)} />
      <InviteIdentity form={state.form} hasAccess={state.hasAccess} />
      <InviteAssignment state={state} />
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onCancel}>Cancelar</Button>
        <Button type="submit" disabled={state.pending}>{state.pending ? "Cadastrando..." : "Cadastrar"}</Button>
      </DialogFooter>
    </form>
  );
}

function FieldError({ message }: { message?: string }) {
  return message ? <p className="text-xs text-destructive">{message}</p> : null;
}

function InviteIdentity({ form, hasAccess }: { form: Form; hasAccess: boolean }) {
  const { errors } = form.formState;
  return (
    <>
      {hasAccess && (
        <div className="space-y-1">
          <Label htmlFor="invite-email">Email</Label>
          <Input id="invite-email" type="email" {...form.register("email")} />
          <FieldError message={errors.email?.message} />
        </div>
      )}
      <div className="space-y-1">
        <Label htmlFor="invite-name">{hasAccess ? "Nome (opcional)" : "Nome"}</Label>
        <Input id="invite-name" {...form.register("name")} />
        <FieldError message={errors.name?.message} />
      </div>
      <PhoneField id="invite-phone" registration={form.register("phone")} error={errors.phone?.message} />
    </>
  );
}

function InviteAssignment({ state }: { state: State }) {
  const { form, hasAccess } = state;
  return (
    <>
      {hasAccess && <RoleSelect value={state.role ?? "OPERATOR"} onChange={(value) => form.setValue("role", value)} />}
      <div className="space-y-1">
        <SectorSelect value={state.sectorId ?? null} onChange={(value) => form.setValue("sectorId", value)} sectors={state.sectors} />
        {hasAccess && <p className="text-xs text-muted-foreground">Administradores podem ficar sem setor.</p>}
        <FieldError message={form.formState.errors.sectorId?.message} />
      </div>
      <ShiftSelect value={state.shiftId ?? null} onChange={(value) => form.setValue("shiftId", value)} shifts={state.shifts} />
      <LevelSelect value={state.levelId ?? null} onChange={(value) => form.setValue("levelId", value)} levels={state.levels} />
      <JobTitleField id="invite-job-title" registration={form.register("jobTitle")} error={form.formState.errors.jobTitle?.message} />
    </>
  );
}

type State = ReturnType<typeof useInviteForm>;
