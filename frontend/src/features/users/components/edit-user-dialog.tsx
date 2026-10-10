import { useEffect } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm, useWatch, type UseFormReturn } from "react-hook-form";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useSectors } from "@/features/internal-admin/api";
import { extractApiError } from "@/lib/api-error";
import { useUpdateUser } from "../api";
import { editableUserPayload } from "../edit-user-payload";
import { editUserSchema, type EditUserInput, type UserSummary } from "../schemas";
import { RoleSelect, SectorSelect } from "./role-sector-selects";

type Props = { user: UserSummary; open: boolean; onOpenChange: (open: boolean) => void; isSelf: boolean };
type Form = UseFormReturn<EditUserInput>;

export function EditUserDialog({ user, open, onOpenChange, isSelf }: Props) {
  const state = useEditUserForm(user, isSelf, onOpenChange);
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent><DialogHeader><DialogTitle>Editar usuário</DialogTitle></DialogHeader><EditUserForm state={state} user={user} isSelf={isSelf} onCancel={() => onOpenChange(false)} /></DialogContent></Dialog>;
}

function useEditUserForm(user: UserSummary, isSelf: boolean, onOpenChange: Props["onOpenChange"]) {
  const update = useUpdateUser();
  const sectors = useSectors(true);
  const form = useForm<EditUserInput>({ resolver: zodResolver(editUserSchema) });
  useEffect(() => form.reset({ name: user.name ?? "", role: user.role, sectorId: user.sectorId, isActive: user.isActive }), [user, form]);
  const submit = async (data: EditUserInput) => {
    try {
      await update.mutateAsync({ id: user.id, data: editableUserPayload(data, isSelf) });
      toast.success("Usuário atualizado.");
      onOpenChange(false);
    } catch (error) {
      const { title, message } = await extractApiError(error);
      toast.error(title, { description: message });
    }
  };
  return { form, isActive: useWatch({ control: form.control, name: "isActive" }), pending: update.isPending, role: useWatch({ control: form.control, name: "role" }), sectorId: useWatch({ control: form.control, name: "sectorId" }), sectors: sectors.data?.items ?? [], submit };
}

function EditUserForm({ state, user, isSelf, onCancel }: { state: State; user: UserSummary; isSelf: boolean; onCancel: () => void }) {
  return <form onSubmit={state.form.handleSubmit(state.submit)} className="space-y-4 py-2"><UserIdentity form={state.form} user={user} /><RoleAndSectorFields state={state} user={user} isSelf={isSelf} /><AccessField form={state.form} isActive={state.isActive} disabled={isSelf} /><DialogFooter><Button type="button" variant="ghost" onClick={onCancel}>Cancelar</Button><Button type="submit" disabled={state.pending}>{state.pending ? "Salvando..." : "Salvar"}</Button></DialogFooter></form>;
}

function UserIdentity({ form, user }: { form: Form; user: UserSummary }) {
  return <><div className="space-y-1"><Label>Email (não editável)</Label><Input value={user.email} disabled /></div><div className="space-y-1"><Label>Nome</Label><Input {...form.register("name")} /></div></>;
}

function RoleAndSectorFields({ state, user, isSelf }: { state: State; user: UserSummary; isSelf: boolean }) {
  const { form } = state;
  return <><div className="space-y-1"><RoleSelect value={state.role ?? user.role} onChange={(value) => form.setValue("role", value)} disabled={isSelf} />{isSelf && <p className="text-xs" style={{ color: "var(--foreground-muted)" }}>Você não pode alterar seu próprio perfil.</p>}</div><div className="space-y-1"><SectorSelect value={state.sectorId ?? null} onChange={(value) => form.setValue("sectorId", value)} sectors={state.sectors} disabled={isSelf} /></div></>;
}

function AccessField({ form, isActive, disabled }: { form: Form; isActive: boolean | undefined; disabled: boolean }) {
  return <div className="space-y-1"><Label>Acesso</Label><Select value={isActive === false ? "inactive" : "active"} onValueChange={(value) => form.setValue("isActive", value === "active")} disabled={disabled}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="active">Ativo</SelectItem><SelectItem value="inactive">Inativo</SelectItem></SelectContent></Select><p className="text-xs text-muted-foreground">Acesso inativo encerra sessões existentes.</p></div>;
}

type State = ReturnType<typeof useEditUserForm>;
