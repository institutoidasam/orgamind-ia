import { useEffect, useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm, useWatch, type UseFormReturn } from "react-hook-form";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useSectors } from "@/features/internal-admin/api";
import { extractApiError } from "@/lib/api-error";
import { useInviteUser } from "../api";
import { inviteUserSchema, type InviteUserOutput } from "../schemas";
import { RoleSelect, SectorSelect } from "./role-sector-selects";
import { TemporaryPasswordModal } from "./temporary-password-modal";

type Props = { open: boolean; onOpenChange: (open: boolean) => void };
type Form = UseFormReturn<InviteUserOutput>;
const EMPTY_INVITE: InviteUserOutput = { email: "", name: "", role: "OPERATOR", sectorId: null };

export function InviteUserDialog({ open, onOpenChange }: Props) {
  const [tmpPwd, setTmpPwd] = useState<string | null>(null);
  const state = useInviteForm(open, onOpenChange, setTmpPwd);
  return <><Dialog open={open} onOpenChange={onOpenChange}><DialogContent><DialogHeader><DialogTitle>Convidar usuário</DialogTitle></DialogHeader><InviteForm state={state} onCancel={() => onOpenChange(false)} /></DialogContent></Dialog>{tmpPwd && <TemporaryPasswordModal password={tmpPwd} onClose={() => setTmpPwd(null)} />}</>;
}

function useInviteForm(open: boolean, onOpenChange: Props["onOpenChange"], setTmpPwd: (password: string) => void) {
  const invite = useInviteUser();
  const sectors = useSectors(true);
  const form = useForm<InviteUserOutput>({ resolver: zodResolver(inviteUserSchema) as never, defaultValues: EMPTY_INVITE });
  useEffect(() => { if (open) form.reset(EMPTY_INVITE); }, [open, form]);
  const submit = async (data: InviteUserOutput) => {
    try {
      const result = await invite.mutateAsync(data);
      setTmpPwd(result.temporaryPassword);
      form.reset(EMPTY_INVITE);
      onOpenChange(false);
    } catch (error) {
      const { title, message } = await extractApiError(error);
      toast.error(title, { description: message });
    }
  };
  return { form, pending: invite.isPending, role: useWatch({ control: form.control, name: "role" }), sectorId: useWatch({ control: form.control, name: "sectorId" }), sectors: sectors.data?.items ?? [], submit };
}

function InviteForm({ state, onCancel }: { state: State; onCancel: () => void }) {
  return <form onSubmit={state.form.handleSubmit(state.submit)} className="space-y-4 py-2"><InviteIdentity form={state.form} /><InviteAssignment state={state} /><DialogFooter><Button type="button" variant="ghost" onClick={onCancel}>Cancelar</Button><Button type="submit" disabled={state.pending}>{state.pending ? "Convidando..." : "Convidar"}</Button></DialogFooter></form>;
}

function InviteIdentity({ form }: { form: Form }) {
  return <><div className="space-y-1"><Label>Email</Label><Input type="email" {...form.register("email")} />{form.formState.errors.email && <p className="text-xs text-destructive">{form.formState.errors.email.message}</p>}</div><div className="space-y-1"><Label>Nome (opcional)</Label><Input {...form.register("name")} /></div></>;
}

function InviteAssignment({ state }: { state: State }) {
  const { form } = state;
  return <><RoleSelect value={state.role ?? "OPERATOR"} onChange={(value) => form.setValue("role", value)} /><div className="space-y-1"><SectorSelect value={state.sectorId ?? null} onChange={(value) => form.setValue("sectorId", value)} sectors={state.sectors} /><p className="text-xs text-muted-foreground">Administradores podem ficar sem setor.</p>{form.formState.errors.sectorId && <p className="text-xs text-destructive">{form.formState.errors.sectorId.message}</p>}</div></>;
}

type State = ReturnType<typeof useInviteForm>;
