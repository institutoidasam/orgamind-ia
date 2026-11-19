import { MoreHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { canChangePersonStatusUi, canViewPersonHistoryUi } from '@/features/people-record/ui-policy';
import type { UserRole } from '../role';
import type { UserSummary } from '../schemas';

type OpenFor = (user: UserSummary) => void;

/** O que o menu abre para a pessoa da linha; a lista passa o estado dos diálogos. */
export type UserMenuDialogs = Record<
  'setEditTarget' | 'setPermissionsTarget' | 'setWhatsappTarget' | 'setResetTarget' | 'setGrantTarget' | 'setStatusTarget' | 'setHistoryTarget' | 'setDeleteTarget',
  OpenFor
>;

/** Dica do item "Enviar WhatsApp" quando desabilitado; undefined quando a pessoa pode receber. */
function whatsappHint(user: UserSummary): string | undefined {
  if (!user.phoneE164) return 'Usuário sem telefone';
  return user.isActive ? undefined : 'Usuário inativo';
}

/** Sem papel conhecido nada é oferecido; com papel, a decisão é só da ui-policy (GC5). */
function menuPermissions(role: UserRole | undefined, user: UserSummary) {
  return {
    status: role !== undefined && canChangePersonStatusUi(role, user),
    history: role !== undefined && canViewPersonHistoryUi(role),
  };
}

function AccessItem({ user, isSelf, dialogs }: { user: UserSummary; isSelf: boolean; dialogs: UserMenuDialogs }) {
  if (!user.hasAccess) return <DropdownMenuItem onClick={() => dialogs.setGrantTarget(user)}>Dar acesso</DropdownMenuItem>;
  return <DropdownMenuItem disabled={isSelf} onClick={() => dialogs.setResetTarget(user)}>Resetar senha</DropdownMenuItem>;
}

/** Ações da linha. Ninguém inativa nem exclui a si mesmo; "Excluir cadastro" é a ação secundária, sempre por último. */
export function UserActionsMenu({ user, isSelf, role, dialogs }: { user: UserSummary; isSelf: boolean; role?: UserRole; dialogs: UserMenuDialogs }) {
  const can = menuPermissions(role, user);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild><Button variant="ghost" size="icon" aria-label="Ações"><MoreHorizontal className="size-4" /></Button></DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => dialogs.setEditTarget(user)}>Editar</DropdownMenuItem>
        {can.history && <DropdownMenuItem onClick={() => dialogs.setHistoryTarget(user)}>Histórico</DropdownMenuItem>}
        {user.hasAccess && <DropdownMenuItem onClick={() => dialogs.setPermissionsTarget(user)}>Ver permissões</DropdownMenuItem>}
        <DropdownMenuItem disabled={!user.phoneE164 || !user.isActive} title={whatsappHint(user)} onClick={() => dialogs.setWhatsappTarget(user)}>Enviar WhatsApp</DropdownMenuItem>
        <AccessItem user={user} isSelf={isSelf} dialogs={dialogs} />
        {can.status && <DropdownMenuItem disabled={isSelf} onClick={() => dialogs.setStatusTarget(user)}>{user.isActive ? 'Inativar' : 'Reativar'}</DropdownMenuItem>}
        <DropdownMenuSeparator />
        <DropdownMenuItem className="text-destructive" disabled={isSelf} onClick={() => dialogs.setDeleteTarget(user)}>Excluir cadastro</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
