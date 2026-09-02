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
import type { UserSummary } from '@/features/users/schemas';

export const Route = createFileRoute('/_authenticated/users/')({
  beforeLoad: () => {
    const { user } = useAuthStore.getState();
    if (user?.role !== 'ADMIN') {
      throw redirect({ to: '/dashboard' });
    }
  },
  component: UsersPage,
});

function UsersPage() {
  const selfId = useAuthStore((s) => s.user?.id);
  const [page] = useState(1);
  const { data, isLoading, isError, error, refetch } = useUsers(page, 20);
  const deleteUser = useDeleteUser();
  const resetPwd = useResetUserPassword();

  const [inviteOpen, setInviteOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<UserSummary | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<UserSummary | null>(null);
  const [resetTarget, setResetTarget] = useState<UserSummary | null>(null);
  const [tmpPwd, setTmpPwd] = useState<string | null>(null);

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await deleteUser.mutateAsync(deleteTarget.id);
      toast.success(`Usuário ${deleteTarget.email} removido.`);
    } catch (err) {
      const { title, message } = await extractApiError(err);
      toast.error(title, { description: message });
    } finally {
      setDeleteTarget(null);
    }
  };

  const handleReset = async () => {
    if (!resetTarget) return;
    try {
      const result = await resetPwd.mutateAsync(resetTarget.id);
      setTmpPwd(result.temporaryPassword);
    } catch (err) {
      const { title, message } = await extractApiError(err);
      toast.error(title, { description: message });
    } finally {
      setResetTarget(null);
    }
  };

  if (isLoading) {
    return (
      <div className="p-8 space-y-3">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    );
  }

  if (isError) {
    return <QueryErrorFallback error={error} onRetry={refetch} className="m-8" />;
  }

  return (
    <div className="p-8 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Usuários</h1>
          <p className="text-sm" style={{ color: 'var(--foreground-muted)' }}>
            {data?.total ?? 0} usuário(s) cadastrado(s)
          </p>
        </div>
        <Button onClick={() => setInviteOpen(true)}>
          <UserPlus className="size-4 mr-2" />
          Convidar usuário
        </Button>
      </div>

      <div className="rounded-md border" style={{ borderColor: 'var(--border)' }}>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Email</TableHead>
              <TableHead>Nome</TableHead>
              <TableHead>Perfil</TableHead>
              <TableHead>Último login</TableHead>
              <TableHead>Convidado por</TableHead>
              <TableHead>Criado em</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {data?.data.map((u) => (
              <TableRow key={u.id}>
                <TableCell className="font-medium">{u.email}</TableCell>
                <TableCell>{u.name ?? '—'}</TableCell>
                <TableCell>
                  <Badge variant={u.role === 'ADMIN' ? 'default' : 'secondary'}>
                    {u.role === 'ADMIN' ? 'Admin' : 'Operador'}
                  </Badge>
                </TableCell>
                <TableCell className="text-sm" style={{ color: 'var(--foreground-muted)' }}>
                  {u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleDateString('pt-BR') : '—'}
                </TableCell>
                <TableCell className="text-sm" style={{ color: 'var(--foreground-muted)' }}>
                  {u.createdBy?.email ?? '—'}
                </TableCell>
                <TableCell className="text-sm" style={{ color: 'var(--foreground-muted)' }}>
                  {new Date(u.createdAt).toLocaleDateString('pt-BR')}
                </TableCell>
                <TableCell>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" aria-label="Ações">
                        <MoreHorizontal className="size-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => setEditTarget(u)}>
                        Editar
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => setResetTarget(u)}>
                        Resetar senha
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        className="text-destructive"
                        disabled={u.id === selfId}
                        onClick={() => setDeleteTarget(u)}
                      >
                        Remover usuário
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <InviteUserDialog open={inviteOpen} onOpenChange={setInviteOpen} />

      {editTarget && (
        <EditUserDialog
          user={editTarget}
          open
          onOpenChange={(o) => { if (!o) setEditTarget(null); }}
          isSelf={editTarget.id === selfId}
        />
      )}

      <AlertDialog open={!!deleteTarget} onOpenChange={(o) => { if (!o) setDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remover usuário?</AlertDialogTitle>
            <AlertDialogDescription>
              O usuário <strong>{deleteTarget?.email}</strong> será permanentemente removido.
              Esta ação não pode ser desfeita.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} disabled={deleteUser.isPending}>
              {deleteUser.isPending ? 'Removendo...' : 'Remover'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!resetTarget} onOpenChange={(o) => { if (!o) setResetTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Resetar senha?</AlertDialogTitle>
            <AlertDialogDescription>
              Uma nova senha temporária será gerada para{' '}
              <strong>{resetTarget?.email}</strong>. O usuário deverá trocá-la no próximo acesso.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={handleReset} disabled={resetPwd.isPending}>
              {resetPwd.isPending ? 'Gerando...' : 'Resetar'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {tmpPwd && <TemporaryPasswordModal password={tmpPwd} onClose={() => setTmpPwd(null)} />}
    </div>
  );
}
