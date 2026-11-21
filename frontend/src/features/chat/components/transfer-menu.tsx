import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useChatAssignees, type AssignConversationInput } from '../api';
import { ConversationActionDialog } from './conversation-action-dialog';

type Target = { id: string; name: string };

/** Destino escolhido com o atendente que a tela mostrava na escolha (K1-3). */
type Picked = Target & { expectedAssigneeId: string | null };

type Props = {
  /** Atendente mostrado na tela: vai como `expectedAssigneeId` e fica fora da lista. */
  assignedUserId: string | null;
  /** Quem olha: "Assumir conversa" cobre o próprio, então fica fora da lista. */
  meId: string;
  /** Alguma ação da conversa em andamento (inclusive esta): o gatilho fica desabilitado. */
  disabled: boolean;
  /** Grava a transferência (a mutação é a mesma de Assumir e Remover). */
  onTransfer: (input: AssignConversationInput) => void;
};

function Destinations({ options, loading, failed, onPick }: {
  options: Target[];
  loading: boolean;
  failed: boolean;
  onPick: (t: Target) => void;
}) {
  if (loading) return <DropdownMenuItem disabled>Carregando…</DropdownMenuItem>;
  if (failed) return <DropdownMenuItem disabled>Não foi possível carregar a lista.</DropdownMenuItem>;
  if (options.length === 0) return <DropdownMenuItem disabled>Ninguém disponível.</DropdownMenuItem>;
  return options.map((o) => (
    <DropdownMenuItem key={o.id} onSelect={() => onPick(o)}>{o.name}</DropdownMenuItem>
  ));
}

/**
 * "Transferir" (K1-7): destinos de `GET chat/assignees` (aberto a quem tem acesso
 * à caixa; não usa `GET /users`), sem o atendente atual e sem quem olha. Escolher
 * uma pessoa abre o diálogo "Transferir para {nome}" com a observação opcional.
 */
export function TransferMenu({ assignedUserId, meId, disabled, onTransfer }: Props) {
  const [open, setOpen] = useState(false);
  // `picked` guarda a última escolha mesmo fechado: o título não troca na animação de saída.
  const [picked, setPicked] = useState<Picked | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const assignees = useChatAssignees(open);
  const options = (assignees.data?.items ?? []).filter((a) => a.id !== assignedUserId && a.id !== meId);

  function pick(target: Target) {
    setPicked({ ...target, expectedAssigneeId: assignedUserId });
    setDialogOpen(true);
  }

  function confirm(note: string | undefined) {
    if (picked) {
      onTransfer({ userId: picked.id, expectedAssigneeId: picked.expectedAssigneeId, ...(note ? { note } : {}) });
    }
    setDialogOpen(false);
  }

  return (
    <>
      <DropdownMenu open={open} onOpenChange={setOpen} modal={false}>
        <DropdownMenuTrigger asChild>
          <Button type="button" size="sm" variant="outline" disabled={disabled}>Transferir</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuLabel>Transferir para</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <Destinations
            options={options}
            loading={assignees.isPending}
            failed={assignees.isError}
            onPick={pick}
          />
        </DropdownMenuContent>
      </DropdownMenu>
      <ConversationActionDialog
        open={dialogOpen}
        title={`Transferir para ${picked?.name ?? ''}`}
        onConfirm={confirm}
        onCancel={() => setDialogOpen(false)}
      />
    </>
  );
}
