import { useState } from 'react';
import { toast } from 'sonner';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { PersonStatusDialog } from '@/features/people-record/components/person-status-dialog';
import { useSetUserStatus } from '../api';
import type { UserSummary } from '../schemas';
import { useInvalidateAuditTrail } from './use-invalidate-audit-trail';

/** Como a pessoa é chamada nos textos: nome quando tem, senão o e-mail. */
function personName(user: UserSummary): string {
  return user.name ?? user.email ?? 'esta pessoa';
}

/** Pessoa com login que está ativa: inativar encerra o acesso, então avisa antes de pedir o motivo. */
function AccessEndNotice({ name, onContinue, onCancel }: { name: string; onContinue: () => void; onCancel: () => void }) {
  return (
    <AlertDialog open onOpenChange={(open) => { if (!open) onCancel(); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Inativar {name}?</AlertDialogTitle>
          <AlertDialogDescription>
            Esta pessoa tem acesso ao sistema. Ao inativar, o acesso é encerrado: as sessões abertas caem e ela só volta a entrar depois de reativada.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancelar</AlertDialogCancel>
          <AlertDialogAction onClick={(event) => { event.preventDefault(); onContinue(); }}>Continuar</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * Inativar ou reativar pela lista, com motivo obrigatório (spec A3). Montado só enquanto há alvo,
 * para o aviso e o motivo começarem do zero a cada abertura.
 */
export function UserStatusFlow({ user, onClose }: { user: UserSummary; onClose: () => void }) {
  const endsAccess = user.hasAccess && user.isActive;
  const [noticeSeen, setNoticeSeen] = useState(!endsAccess);
  const setStatus = useSetUserStatus();
  const invalidateAuditTrail = useInvalidateAuditTrail();
  const name = personName(user);
  const confirm = async (reason: string) => {
    await setStatus.mutateAsync({ id: user.id, isActive: !user.isActive, reason });
    invalidateAuditTrail();
    toast.success(`Cadastro de ${name} ${user.isActive ? 'inativado' : 'reativado'}.`);
  };
  if (!noticeSeen) return <AccessEndNotice name={name} onContinue={() => setNoticeSeen(true)} onCancel={onClose} />;
  return (
    <PersonStatusDialog
      person={{ name, isActive: user.isActive }}
      open
      onOpenChange={(open) => { if (!open) onClose(); }}
      onConfirm={confirm}
    />
  );
}
