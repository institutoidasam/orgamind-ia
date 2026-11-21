import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { useAuthStore } from '@/stores/auth.store';
import {
  useAssignConversation,
  useReopenConversation,
  useResolveConversation,
  type AssignConversationInput,
} from '../api';
import type { ConversationSummary } from '../schemas';
import { conversationActions } from '../situation';
import { ConversationActionDialog } from './conversation-action-dialog';
import { TransferMenu } from './transfer-menu';

type Kind = 'resolve' | 'reopen' | 'remove';

/**
 * Pedido do diálogo com o que a tela mostrava ao abrir a ação: os `expected…`
 * vão no corpo mesmo que a conversa recarregue com o diálogo aberto (K1-3).
 */
type Pending = { kind: Kind; expectedAssigneeId: string | null; expectedLastInboundAt: string | null };

const DIALOG_TITLE: Record<Kind, string> = {
  resolve: 'Resolver conversa',
  reopen: 'Reabrir conversa',
  remove: 'Remover atendente',
};

function ActionButton({ label, disabled, onClick }: { label: string; disabled: boolean; onClick: () => void }) {
  return (
    <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={onClick}>
      {label}
    </Button>
  );
}

/**
 * Mutações de situação da conversa. Uma só instância de `assign` para Assumir,
 * Remover e Transferir: `busy` cobre também a transferência em andamento.
 */
function useSituationMutations(conversationId: string) {
  const resolve = useResolveConversation(conversationId);
  const reopen = useReopenConversation(conversationId);
  const assign = useAssignConversation(conversationId);
  return {
    busy: resolve.isPending || reopen.isPending || assign.isPending,
    assign: (input: AssignConversationInput) => assign.mutate(input),
    submit({ kind, expectedAssigneeId, expectedLastInboundAt }: Pending, note: string | undefined) {
      const withNote = note ? { note } : {};
      if (kind === 'resolve') {
        resolve.mutate({ expectedAssigneeId, expectedLastInboundAt, ...withNote });
      } else if (kind === 'reopen') {
        reopen.mutate(withNote);
      } else {
        assign.mutate({ userId: null, expectedAssigneeId, ...withNote });
      }
    },
  };
}

/**
 * Ações da conversa no cabeçalho (K1-3, K1-4, K1-7): Resolver, Reabrir, Assumir
 * conversa, Transferir e Remover atendente, só os que `conversationActions`
 * libera para quem olha. Esconder não é autorizar: o servidor decide (403/409,
 * com toast e recarga pelos hooks).
 */
export function ConversationActions({ conv }: { conv: ConversationSummary }) {
  const me = useAuthStore((s) => s.user);
  // `pending` guarda o último pedido mesmo fechado: o título não troca na animação de saída.
  const [pending, setPending] = useState<Pending | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const { busy, assign, submit } = useSituationMutations(conv.id);
  if (!me) return null;
  const can = conversationActions(conv, me);
  const expectedAssigneeId = conv.assignedUserId ?? null;

  function start(kind: Kind) {
    setPending({ kind, expectedAssigneeId, expectedLastInboundAt: conv.lastInboundAt ?? null });
    setDialogOpen(true);
  }

  function confirm(note: string | undefined) {
    if (pending) submit(pending, note);
    setDialogOpen(false);
  }

  // Abaixo de `sm` ocupa a linha inteira (os botões quebram entre si, sem sair do
  // cartão); de `sm` em diante fica à direita, na linha do nome, quando couber.
  // `empty:hidden`: sem ação liberada não reserva uma linha vazia.
  return (
    <div className="flex w-full flex-wrap items-center justify-start gap-1.5 empty:hidden sm:ml-auto sm:w-auto sm:justify-end">
      {can.resolve ? <ActionButton label="Resolver" disabled={busy} onClick={() => start('resolve')} /> : null}
      {can.reopen ? <ActionButton label="Reabrir" disabled={busy} onClick={() => start('reopen')} /> : null}
      {can.assume ? (
        <ActionButton
          label="Assumir conversa"
          disabled={busy}
          onClick={() => assign({ userId: me.id, expectedAssigneeId })}
        />
      ) : null}
      {can.transfer ? (
        <TransferMenu assignedUserId={expectedAssigneeId} meId={me.id} disabled={busy} onTransfer={assign} />
      ) : null}
      {can.remove ? <ActionButton label="Remover atendente" disabled={busy} onClick={() => start('remove')} /> : null}
      <ConversationActionDialog
        open={dialogOpen}
        title={DIALOG_TITLE[pending?.kind ?? 'resolve']}
        onConfirm={confirm}
        onCancel={() => setDialogOpen(false)}
      />
    </div>
  );
}
