import { useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm, useWatch } from "react-hook-form";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useGrantAccess } from "../api";
import { grantAccessSchema, type GrantAccessOutput, type UserSummary } from "../schemas";
import { toastUserError } from "../submit-error";
import { RoleSelect } from "./role-sector-selects";
import { TemporaryPasswordModal } from "./temporary-password-modal";

type Props = { user: UserSummary | null; onClose: () => void };

/** Dar acesso a uma pessoa sem acesso: e-mail + perfil; a senha temporária aparece no fim, como no convite. */
export function GrantAccessDialog({ user, onClose }: Props) {
  const [tmpPwd, setTmpPwd] = useState<string | null>(null);
  const finish = () => {
    setTmpPwd(null);
    onClose();
  };
  return (
    <>
      <Dialog open={user !== null && tmpPwd === null} onOpenChange={(open) => { if (!open) finish(); }}>
        <DialogContent>
          {user && <GrantAccessForm key={user.id} user={user} onGranted={setTmpPwd} onCancel={finish} />}
        </DialogContent>
      </Dialog>
      {tmpPwd && <TemporaryPasswordModal password={tmpPwd} onClose={finish} />}
    </>
  );
}

function GrantAccessForm({ user, onGranted, onCancel }: { user: UserSummary; onGranted: (password: string) => void; onCancel: () => void }) {
  const grant = useGrantAccess();
  const form = useForm<GrantAccessOutput>({ resolver: zodResolver(grantAccessSchema) as never, defaultValues: { email: "", role: "OPERATOR" } });
  const submit = async (data: GrantAccessOutput) => {
    try {
      const result = await grant.mutateAsync({ id: user.id, email: data.email, role: data.role });
      onGranted(result.temporaryPassword);
    } catch (error) {
      await toastUserError(error);
    }
  };
  const role = useWatch({ control: form.control, name: "role" }) ?? "OPERATOR";
  const emailError = form.formState.errors.email?.message;
  return (
    <form onSubmit={form.handleSubmit(submit)} className="space-y-4 py-2">
      <DialogHeader>
        <DialogTitle>Dar acesso</DialogTitle>
        <DialogDescription>{user.name ?? "Esta pessoa"} passa a entrar no sistema com o e-mail e o perfil abaixo.</DialogDescription>
      </DialogHeader>
      <div className="space-y-1">
        <Label htmlFor="grant-email">Email</Label>
        <Input id="grant-email" type="email" {...form.register("email")} />
        {emailError && <p className="text-xs text-destructive">{emailError}</p>}
      </div>
      <RoleSelect value={role} onChange={(role) => form.setValue("role", role)} />
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onCancel}>Cancelar</Button>
        <Button type="submit" disabled={grant.isPending}>{grant.isPending ? "Dando acesso..." : "Dar acesso"}</Button>
      </DialogFooter>
    </form>
  );
}
