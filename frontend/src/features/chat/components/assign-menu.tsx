import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useUsers } from '@/features/users/api';
import { useAssignConversation } from '../api';

/**
 * "Atribuir" dropdown for the message-thread header. Lists operators (via
 * useUsers) plus a "Remover atribuição" option, wired to useAssignConversation.
 * Só quem tem acesso recebe a conversa: o filtro `hasAccess` é do servidor (filtrar
 * no cliente esconderia agentes reais além da 1ª página).
 */
export function AssignMenu({
  conversationId,
  assignedUserId,
  assignedUserName,
}: {
  conversationId: string;
  assignedUserId: string | null;
  assignedUserName: string | null;
}) {
  const usersQuery = useUsers(1, 100, { hasAccess: true });
  const assign = useAssignConversation(conversationId);
  const users = usersQuery.data?.data ?? [];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="shrink-0 rounded-md px-2 py-1 text-xs font-medium"
          style={{ background: 'var(--surface-sunken)', color: 'var(--foreground-muted)' }}
        >
          {assignedUserId ? (assignedUserName ?? 'Atribuído') : 'Atribuir'}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuLabel>Atribuir conversa</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {users.map((u) => (
          <DropdownMenuItem
            key={u.id}
            disabled={assign.isPending}
            onSelect={() => assign.mutate({ userId: u.id })}
          >
            {u.name ?? u.email}
          </DropdownMenuItem>
        ))}
        {assignedUserId ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              disabled={assign.isPending}
              onSelect={() => assign.mutate({ userId: null })}
            >
              Remover atribuição
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
