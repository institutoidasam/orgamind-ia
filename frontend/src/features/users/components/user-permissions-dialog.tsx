import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import type { UserSummary } from "../schemas";
import { ROLE_LABEL, ROLE_PERMISSIONS } from "../role";

type Props = {
  user: UserSummary;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function UserPermissionsDialog({ user, open, onOpenChange }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Permissões de {user.name ?? user.email}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <p>
            <strong>{ROLE_LABEL[user.role]}</strong> ·{" "}
            {user.sector?.name ?? "Sem setor definido"}
          </p>
          <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
            {ROLE_PERMISSIONS[user.role].map((permission) => (
              <li key={permission}>{permission}</li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">
            Acesso a canais externos é definido na configuração de cada canal.
          </p>
        </div>
        <DialogFooter>
          <Button type="button" onClick={() => onOpenChange(false)}>
            Fechar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
