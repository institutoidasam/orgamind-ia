import { useState } from 'react';
import { createFileRoute, redirect } from '@tanstack/react-router';
import { toast } from 'sonner';
import { UserPlus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { QueryErrorFallback } from '@/components/query-error-fallback';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuthStore } from '@/stores/auth.store';
import { useUsers, useDeleteUser, useResetUserPassword } from '@/features/users/api';
import { AuthorizationBadge } from '@/features/people-record/components/authorization-badge';
import { PersonHistoryDialog } from '@/features/audit-trail/components/person-history-dialog';
import { ExportPeopleButton } from '@/features/people-export/components/export-people-button';
import { InviteUserDialog } from '@/features/users/components/invite-user-dialog';
import { EditUserDialog } from '@/features/users/components/edit-user-dialog';
import { GrantAccessDialog } from '@/features/users/components/grant-access-dialog';
import { TemporaryPasswordModal } from '@/features/users/components/temporary-password-modal';
import { UserPermissionsDialog } from '@/features/users/components/user-permissions-dialog';
import { UserActionsMenu } from '@/features/users/components/user-actions-menu';
import { UserStatusFlow } from '@/features/users/components/user-status-flow';
import { UsersFilterBar } from '@/features/users/components/users-filter-bar';
import { useInvalidateAuditTrail } from '@/features/users/components/use-invalidate-audit-trail';
import { useUsersFilterState } from '@/features/users/components/use-users-filter-state';
import { SendWhatsappDialog } from '@/features/team-whatsapp/components/send-whatsapp-dialog';
import { formatPhoneBR } from '@/lib/format-phone';
import { useShifts } from '@/features/shifts/api';
import { NO_SHIFT_LABEL } from '@/features/shifts/labels';
import { ROLE_LABEL, type UserRole } from '@/features/users/role';
import { toastUserError } from '@/features/users/submit-error';
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
  const role = useAuthStore((s) => s.user?.role);
  const [page] = useState(1);
  const filters = useUsersFilterState();
  const query = useUsers(page, 20, filters.filters);
  const deleteUser = useDeleteUser();
  const resetPwd = useResetUserPassword();
  const invalidateAuditTrail = useInvalidateAuditTrail();
  const dialogs = useUserDialogState();
  return (
    <div className="p-8 space-y-6">
      <UsersHeader onInvite={() => dialogs.setInviteOpen(true)} />
      <UsersFilterBar filters={filters} counts={query.data?.authorizationCounts} />
      <UsersContent query={query} selfId={selfId} role={role} dialogs={dialogs} />
      <UserDialogs
        dialogs={dialogs}
        selfId={selfId}
        deletePending={deleteUser.isPending}
        resetPending={resetPwd.isPending}
        onDelete={() => deleteSelectedUser(dialogs.deleteTarget, deleteUser, () => dialogs.setDeleteTarget(null), invalidateAuditTrail)}
        onReset={() => resetSelectedUser(dialogs.resetTarget, resetPwd, dialogs.setTmpPwd, () => dialogs.setResetTarget(null))}
      />
    </div>
  );
}

function UserListSkeleton() {
  return <div className="space-y-3">{Array.from({ length: 5 }).map((_, index) => <Skeleton key={index} className="h-10 w-full" />)}</div>;
}

/** Só a lista carrega ou falha: o cabeçalho e os filtros ficam de pé enquanto uma busca nova responde. */
function UsersContent({ query, selfId, role, dialogs }: { query: ReturnType<typeof useUsers>; selfId?: string; role?: UserRole; dialogs: UserDialogState }) {
  if (query.isLoading) return <UserListSkeleton />;
  if (query.isError) return <QueryErrorFallback error={query.error} onRetry={query.refetch} />;
  const users = query.data?.data ?? [];
  if (users.length === 0) return <p className="text-sm text-muted-foreground">Nenhuma pessoa encontrada.</p>;
  return <UsersTable users={users} selfId={selfId} role={role} dialogs={dialogs} />;
}

function useUserDialogState() {
  const [inviteOpen, setInviteOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<UserSummary | null>(null);
  const [permissionsTarget, setPermissionsTarget] = useState<UserSummary | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<UserSummary | null>(null);
  const [resetTarget, setResetTarget] = useState<UserSummary | null>(null);
  const [grantTarget, setGrantTarget] = useState<UserSummary | null>(null);
  const [whatsappTarget, setWhatsappTarget] = useState<UserSummary | null>(null);
  const [statusTarget, setStatusTarget] = useState<UserSummary | null>(null);
  const [historyTarget, setHistoryTarget] = useState<UserSummary | null>(null);
  const [tmpPwd, setTmpPwd] = useState<string | null>(null);
  return { whatsappTarget, setWhatsappTarget, inviteOpen, setInviteOpen, editTarget, setEditTarget, permissionsTarget, setPermissionsTarget, deleteTarget, setDeleteTarget, resetTarget, setResetTarget, grantTarget, setGrantTarget, statusTarget, setStatusTarget, historyTarget, setHistoryTarget, tmpPwd, setTmpPwd };
}

type UserDialogState = ReturnType<typeof useUserDialogState>;

function UsersHeader({ onInvite }: { onInvite: () => void }) {
  return (
    <div className="flex items-center justify-between">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.14em]" style={{ color: 'var(--foreground-muted)' }}>Administração / acesso</p>
        <h1 className="text-2xl font-bold">Usuários</h1>
        <p className="text-sm" style={{ color: 'var(--foreground-muted)' }}>Cada pessoa tem um setor principal e um papel de acesso.</p>
      </div>
      <div className="flex items-center gap-2">
        <ExportPeopleButton />
        <Button onClick={onInvite}><UserPlus className="size-4 mr-2" />Cadastrar usuário</Button>
      </div>
    </div>
  );
}

function UsersTable({ users, selfId, role, dialogs }: { users: UserSummary[]; selfId?: string; role?: UserRole; dialogs: UserDialogState }) {
  const shiftNames = new Map((useShifts().data ?? []).map((shift) => [shift.id, shift.name]));
  return (
    <div className="rounded-md border" style={{ borderColor: 'var(--border)' }}>
      <Table>
        <TableHeader><TableRow><TableHead>Nome</TableHead><TableHead>Matrícula</TableHead><TableHead>Email</TableHead><TableHead>Telefone</TableHead><TableHead>Setor</TableHead><TableHead>Turno</TableHead><TableHead>Função</TableHead><TableHead>Perfil</TableHead><TableHead>Acesso</TableHead><TableHead className="w-10" /></TableRow></TableHeader>
        <TableBody>{users.map((user) => <UserRow key={user.id} user={user} shiftNames={shiftNames} isSelf={user.id === selfId} role={role} dialogs={dialogs} />)}</TableBody>
      </Table>
    </div>
  );
}

/** Nome do turno (mesmo inativo); "Sem turno" quando não há; traço enquanto a lista carrega. */
function shiftCellText(user: UserSummary, shiftNames: ReadonlyMap<string, string>): string {
  if (!user.shiftId) return NO_SHIFT_LABEL;
  return shiftNames.get(user.shiftId) ?? '—';
}

/** Quem tem login mostra Ativo/Inativo; quem não tem mostra "Sem acesso", e "Inativo" também quando a pessoa foi inativada. */
function AccessBadge({ user }: { user: UserSummary }) {
  if (!user.hasAccess) {
    return <div className="flex gap-1"><Badge variant="outline">Sem acesso</Badge>{!user.isActive && <Badge variant="outline">Inativo</Badge>}</div>;
  }
  return <Badge variant={user.isActive ? 'default' : 'outline'}>{user.isActive ? 'Ativo' : 'Inativo'}</Badge>;
}

/** Como a pessoa é chamada em mensagens: e-mail quando tem, senão o nome. */
function userLabel(user: UserSummary): string {
  return user.email ?? user.name ?? 'esta pessoa';
}

function UserRow({ user, shiftNames, isSelf, role, dialogs }: { user: UserSummary; shiftNames: ReadonlyMap<string, string>; isSelf: boolean; role?: UserRole; dialogs: UserDialogState }) {
  return (
    <TableRow>
      <TableCell className="font-medium"><div className="flex flex-wrap items-center gap-2">{user.name ?? '—'}<AuthorizationBadge authorization={user.contactAuthorization} /></div></TableCell>
      <TableCell className="text-sm">{user.registration ?? '—'}</TableCell>
      <TableCell className="text-sm" style={{ color: 'var(--foreground-muted)' }}>{user.email ?? '—'}</TableCell>
      <TableCell className="text-sm">{formatPhoneBR(user.phoneE164)}</TableCell>
      <TableCell>{user.sector?.name ?? 'Sem setor'}</TableCell>
      <TableCell>{shiftCellText(user, shiftNames)}</TableCell>
      <TableCell>{user.jobTitle ?? '—'}</TableCell>
      <TableCell>{user.hasAccess ? <Badge variant={user.role === 'ADMIN' ? 'default' : 'secondary'}>{ROLE_LABEL[user.role]}</Badge> : '—'}</TableCell>
      <TableCell><AccessBadge user={user} /></TableCell>
      <TableCell><UserActionsMenu user={user} isSelf={isSelf} role={role} dialogs={dialogs} /></TableCell>
    </TableRow>
  );
}

function UserDialogs({ dialogs, selfId, deletePending, resetPending, onDelete, onReset }: { dialogs: UserDialogState; selfId?: string; deletePending: boolean; resetPending: boolean; onDelete: () => Promise<void>; onReset: () => Promise<void> }) {
  const invalidateAuditTrail = useInvalidateAuditTrail();
  return <>
    <InviteUserDialog open={dialogs.inviteOpen} onOpenChange={dialogs.setInviteOpen} />
    <GrantAccessDialog user={dialogs.grantTarget} onClose={() => { dialogs.setGrantTarget(null); invalidateAuditTrail(); }} />
    {dialogs.editTarget && <EditUserDialog user={dialogs.editTarget} open onOpenChange={(open) => { if (!open) { dialogs.setEditTarget(null); invalidateAuditTrail(); } }} isSelf={dialogs.editTarget.id === selfId} />}
    {dialogs.permissionsTarget && <UserPermissionsDialog user={dialogs.permissionsTarget} open onOpenChange={(open) => { if (!open) dialogs.setPermissionsTarget(null); }} />}
    {dialogs.whatsappTarget && <SendWhatsappDialog open target={{ type: 'user', userId: dialogs.whatsappTarget.id, label: dialogs.whatsappTarget.name ?? dialogs.whatsappTarget.email ?? '' }} onOpenChange={(open) => { if (!open) dialogs.setWhatsappTarget(null); }} />}
    {dialogs.statusTarget && <UserStatusFlow user={dialogs.statusTarget} onClose={() => dialogs.setStatusTarget(null)} />}
    {dialogs.historyTarget && <UserHistoryDialog user={dialogs.historyTarget} onClose={() => dialogs.setHistoryTarget(null)} />}
    <DeleteUserDialog user={dialogs.deleteTarget} pending={deletePending} onOpenChange={(open) => { if (!open) dialogs.setDeleteTarget(null); }} onDelete={onDelete} />
    <ResetUserDialog user={dialogs.resetTarget} pending={resetPending} onOpenChange={(open) => { if (!open) dialogs.setResetTarget(null); }} onReset={onReset} />
    {dialogs.tmpPwd && <TemporaryPasswordModal password={dialogs.tmpPwd} onClose={() => dialogs.setTmpPwd(null)} />}
  </>;
}

function UserHistoryDialog({ user, onClose }: { user: UserSummary; onClose: () => void }) {
  return <PersonHistoryDialog person={{ id: user.id, name: user.name ?? userLabel(user) }} open onOpenChange={(open) => { if (!open) onClose(); }} />;
}

function DeleteUserDialog({ user, pending, onOpenChange, onDelete }: { user: UserSummary | null; pending: boolean; onOpenChange: (open: boolean) => void; onDelete: () => Promise<void> }) {
  return <AlertDialog open={!!user} onOpenChange={onOpenChange}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Excluir cadastro?</AlertDialogTitle><AlertDialogDescription>O cadastro de <strong>{user && userLabel(user)}</strong> será excluído de vez. Só é possível quando a pessoa não tem histórico; se tiver, inative o cadastro.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>Cancelar</AlertDialogCancel><AlertDialogAction onClick={onDelete} disabled={pending}>{pending ? 'Excluindo...' : 'Excluir'}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>;
}

function ResetUserDialog({ user, pending, onOpenChange, onReset }: { user: UserSummary | null; pending: boolean; onOpenChange: (open: boolean) => void; onReset: () => Promise<void> }) {
  return <AlertDialog open={!!user} onOpenChange={onOpenChange}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Resetar senha?</AlertDialogTitle><AlertDialogDescription>Uma nova senha temporária será gerada para <strong>{user && userLabel(user)}</strong>. O usuário deverá trocá-la no próximo acesso.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>Cancelar</AlertDialogCancel><AlertDialogAction onClick={onReset} disabled={pending}>{pending ? 'Gerando...' : 'Resetar'}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>;
}

/** Recusa por histórico (409 `user.has_history`) chega como toast com a orientação de inativar (toastUserError). */
async function deleteSelectedUser(user: UserSummary | null, mutation: ReturnType<typeof useDeleteUser>, close: () => void, afterDelete: () => void) {
  if (!user) return;
  try {
    await mutation.mutateAsync(user.id);
    afterDelete();
    toast.success(`Cadastro de ${userLabel(user)} excluído.`);
  } catch (error) {
    await toastUserError(error);
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
    await toastUserError(error);
  } finally {
    close();
  }
}
