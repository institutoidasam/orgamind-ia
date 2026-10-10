import { useState } from 'react';
import { createFileRoute, redirect } from '@tanstack/react-router';
import { toast } from 'sonner';
import { UserPlus, MoreHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { QueryErrorFallback } from '@/components/query-error-fallback';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuthStore } from '@/stores/auth.store';
import { extractApiError } from '@/lib/api-error';
import { useUsers, useDeleteUser, useResetUserPassword } from '@/features/users/api';
import { InviteUserDialog } from '@/features/users/components/invite-user-dialog';
import { EditUserDialog } from '@/features/users/components/edit-user-dialog';
import { TemporaryPasswordModal } from '@/features/users/components/temporary-password-modal';
import { UserPermissionsDialog } from '@/features/users/components/user-permissions-dialog';
import { ROLE_LABEL } from '@/features/users/role';
import type { UserSummary } from '@/features/users/schemas';

const route = createFileRoute('/_authenticated/users/')({
  beforeLoad: () => {
    const { user } = useAuthStore.getState();
    if (user?.role !== 'ADMIN') {
      throw redirect({ to: '/dashboard' });
    }
  },
  component: UsersPage,
});
export { route as Route };

function UsersPage() {
  const selfId = useAuthStore((s) => s.user?.id);
  const [page] = useState(1);
  const { data, isLoading, isError, error, refetch } = useUsers(page, 20);
  const deleteUser = useDeleteUser();
  const resetPwd = useResetUserPassword();
  const dialogs = useUserDialogState();

  if (isLoading) {
    return <UserListSkeleton />;
  }
  if (isError) {
    return <QueryErrorFallback error={error} onRetry={refetch} className="m-8" />;
  }
  return (
    <UsersScreen
      users={data?.data ?? []}
      selfId={selfId}
      dialogs={dialogs}
      deletePending={deleteUser.isPending}
      resetPending={resetPwd.isPending}
      onDelete={() => deleteSelectedUser(dialogs.deleteTarget, deleteUser, () => dialogs.setDeleteTarget(null))}
      onReset={() => resetSelectedUser(dialogs.resetTarget, resetPwd, dialogs.setTmpPwd, () => dialogs.setResetTarget(null))}
    />
  );
}

function UserListSkeleton() {
  return <div className="p-8 space-y-3">{Array.from({ length: 5 }).map((_, index) => <Skeleton key={index} className="h-10 w-full" />)}</div>;
}

function useUserDialogState() {
  const [inviteOpen, setInviteOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<UserSummary | null>(null);
  const [permissionsTarget, setPermissionsTarget] = useState<UserSummary | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<UserSummary | null>(null);
  const [resetTarget, setResetTarget] = useState<UserSummary | null>(null);
  const [tmpPwd, setTmpPwd] = useState<string | null>(null);
  return { inviteOpen, setInviteOpen, editTarget, setEditTarget, permissionsTarget, setPermissionsTarget, deleteTarget, setDeleteTarget, resetTarget, setResetTarget, tmpPwd, setTmpPwd };
}

type UserDialogState = ReturnType<typeof useUserDialogState>;

function UsersScreen({ users, selfId, dialogs, deletePending, resetPending, onDelete, onReset }: { users: UserSummary[]; selfId?: string; dialogs: UserDialogState; deletePending: boolean; resetPending: boolean; onDelete: () => Promise<void>; onReset: () => Promise<void> }) {
  return (
    <div className="p-8 space-y-6">
      <UsersHeader onInvite={() => dialogs.setInviteOpen(true)} />
      <UsersTable users={users} selfId={selfId} dialogs={dialogs} />
      <UserDialogs dialogs={dialogs} selfId={selfId} deletePending={deletePending} resetPending={resetPending} onDelete={onDelete} onReset={onReset} />
    </div>
  );
}

function UsersHeader({ onInvite }: { onInvite: () => void }) {
  return (
    <div className="flex items-center justify-between">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.14em]" style={{ color: 'var(--foreground-muted)' }}>Administração / acesso</p>
        <h1 className="text-2xl font-bold">Usuários</h1>
        <p className="text-sm" style={{ color: 'var(--foreground-muted)' }}>Cada pessoa tem um setor principal e um papel de acesso.</p>
      </div>
      <Button onClick={onInvite}><UserPlus className="size-4 mr-2" />Convidar usuário</Button>
    </div>
  );
}

function UsersTable({ users, selfId, dialogs }: { users: UserSummary[]; selfId?: string; dialogs: UserDialogState }) {
  return (
    <div className="rounded-md border" style={{ borderColor: 'var(--border)' }}>
      <Table>
        <TableHeader><TableRow><TableHead>Nome</TableHead><TableHead>Email</TableHead><TableHead>Setor</TableHead><TableHead>Perfil</TableHead><TableHead>Acesso</TableHead><TableHead className="w-10" /></TableRow></TableHeader>
        <TableBody>{users.map((user) => <UserRow key={user.id} user={user} isSelf={user.id === selfId} dialogs={dialogs} />)}</TableBody>
      </Table>
    </div>
  );
}

function UserRow({ user, isSelf, dialogs }: { user: UserSummary; isSelf: boolean; dialogs: UserDialogState }) {
  return (
    <TableRow>
      <TableCell className="font-medium">{user.name ?? '—'}</TableCell>
      <TableCell className="text-sm" style={{ color: 'var(--foreground-muted)' }}>{user.email}</TableCell>
      <TableCell>{user.sector?.name ?? 'Sem setor'}</TableCell>
      <TableCell><Badge variant={user.role === 'ADMIN' ? 'default' : 'secondary'}>{ROLE_LABEL[user.role]}</Badge></TableCell>
      <TableCell><Badge variant={user.isActive ? 'default' : 'outline'}>{user.isActive ? 'Ativo' : 'Inativo'}</Badge></TableCell>
      <TableCell>
        <DropdownMenu>
          <DropdownMenuTrigger asChild><Button variant="ghost" size="icon" aria-label="Ações"><MoreHorizontal className="size-4" /></Button></DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => dialogs.setEditTarget(user)}>Editar</DropdownMenuItem>
            <DropdownMenuItem onClick={() => dialogs.setPermissionsTarget(user)}>Ver permissões</DropdownMenuItem>
            <DropdownMenuItem disabled={isSelf} onClick={() => dialogs.setResetTarget(user)}>Resetar senha</DropdownMenuItem>
            <DropdownMenuItem className="text-destructive" disabled={isSelf} onClick={() => dialogs.setDeleteTarget(user)}>Remover usuário</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </TableCell>
    </TableRow>
  );
}

function UserDialogs({ dialogs, selfId, deletePending, resetPending, onDelete, onReset }: { dialogs: UserDialogState; selfId?: string; deletePending: boolean; resetPending: boolean; onDelete: () => Promise<void>; onReset: () => Promise<void> }) {
  return <>
    <InviteUserDialog open={dialogs.inviteOpen} onOpenChange={dialogs.setInviteOpen} />
    {dialogs.editTarget && <EditUserDialog user={dialogs.editTarget} open onOpenChange={(open) => { if (!open) dialogs.setEditTarget(null); }} isSelf={dialogs.editTarget.id === selfId} />}
    {dialogs.permissionsTarget && <UserPermissionsDialog user={dialogs.permissionsTarget} open onOpenChange={(open) => { if (!open) dialogs.setPermissionsTarget(null); }} />}
    <DeleteUserDialog user={dialogs.deleteTarget} pending={deletePending} onOpenChange={(open) => { if (!open) dialogs.setDeleteTarget(null); }} onDelete={onDelete} />
    <ResetUserDialog user={dialogs.resetTarget} pending={resetPending} onOpenChange={(open) => { if (!open) dialogs.setResetTarget(null); }} onReset={onReset} />
    {dialogs.tmpPwd && <TemporaryPasswordModal password={dialogs.tmpPwd} onClose={() => dialogs.setTmpPwd(null)} />}
  </>;
}

function DeleteUserDialog({ user, pending, onOpenChange, onDelete }: { user: UserSummary | null; pending: boolean; onOpenChange: (open: boolean) => void; onDelete: () => Promise<void> }) {
  return <AlertDialog open={!!user} onOpenChange={onOpenChange}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Remover usuário?</AlertDialogTitle><AlertDialogDescription>O usuário <strong>{user?.email}</strong> será permanentemente removido. Esta ação não pode ser desfeita.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>Cancelar</AlertDialogCancel><AlertDialogAction onClick={onDelete} disabled={pending}>{pending ? 'Removendo...' : 'Remover'}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>;
}

function ResetUserDialog({ user, pending, onOpenChange, onReset }: { user: UserSummary | null; pending: boolean; onOpenChange: (open: boolean) => void; onReset: () => Promise<void> }) {
  return <AlertDialog open={!!user} onOpenChange={onOpenChange}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Resetar senha?</AlertDialogTitle><AlertDialogDescription>Uma nova senha temporária será gerada para <strong>{user?.email}</strong>. O usuário deverá trocá-la no próximo acesso.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>Cancelar</AlertDialogCancel><AlertDialogAction onClick={onReset} disabled={pending}>{pending ? 'Gerando...' : 'Resetar'}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>;
}

async function deleteSelectedUser(user: UserSummary | null, mutation: ReturnType<typeof useDeleteUser>, close: () => void) {
  if (!user) return;
  try {
    await mutation.mutateAsync(user.id);
    toast.success(`Usuário ${user.email} removido.`);
  } catch (error) {
    const { title, message } = await extractApiError(error);
    toast.error(title, { description: message });
  } finally {
    close();
  }
}

async function resetSelectedUser(user: UserSummary | null, mutation: ReturnType<typeof useResetUserPassword>, setTemporaryPassword: (password: string) => void, close: () => void) {
  if (!user) return;
  try {
    const result = await mutation.mutateAsync(user.id);
    setTemporaryPassword(result.temporaryPassword);
  } catch (error) {
    const { title, message } = await extractApiError(error);
    toast.error(title, { description: message });
  } finally {
    close();
  }
}
