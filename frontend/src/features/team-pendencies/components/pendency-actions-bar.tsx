import { useState } from "react";
import { useIsMutating, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  alertActionErrorText,
  useUndoManualAck,
} from "@/features/team-whatsapp/alert-actions-api";
import type { AlertPerson } from "@/features/team-whatsapp/alert-schemas";
import { ManualAckDialog } from "@/features/team-whatsapp/components/manual-ack-dialog";
import {
  invalidatePendencies,
  PENDENCIES_KEY,
  usePendencyAction,
  type PendencyActionInput,
} from "../api";
import { REMOVED_USER_LABEL } from "../labels";
import { pendencyActions, type PendencyMe } from "../pendency-actions";
import type { TeamPendencyItem } from "../schemas";
import {
  PendencyTextDialog,
  type PendencyTextField,
} from "./pendency-text-dialog";
import { PendencyTransferMenu } from "./pendency-transfer-menu";

type Props = { item: TeamPendencyItem; me: PendencyMe };

type DialogKind = "assume" | "note" | "close" | "reopen";

/** Pedido do diálogo com o responsável que a tela mostrava ao abri-lo: segue no corpo mesmo que a lista recarregue. */
type Pending = { kind: DialogKind; expectedHandlerId: string | null };

const DIALOG_FIELD: Record<DialogKind, PendencyTextField | undefined> = {
  assume: { label: "Observação (opcional)", required: false },
  note: { label: "O que foi feito e por qual meio", required: true },
  close: { label: "Motivo", required: true },
  reopen: undefined,
};

function dialogTitle(kind: DialogKind, item: TeamPendencyItem): string {
  if (kind === "assume")
    return `Assumir pendência de ${item.handler?.name ?? REMOVED_USER_LABEL}`;
  if (kind === "note") return "Registrar contato";
  return kind === "close" ? "Encerrar sem ciência" : "Reabrir a tratativa?";
}

/** O pedido da ação a partir do diálogo; o texto já vem aparado e, onde é obrigatório, não vazio. */
function actionInput(
  { kind, expectedHandlerId }: Pending,
  text: string | undefined,
): PendencyActionInput {
  const value = text ?? "";
  if (kind === "assume")
    return text
      ? { kind, expectedHandlerId, note: text }
      : { kind, expectedHandlerId };
  if (kind === "note") return { kind, expectedHandlerId, text: value };
  if (kind === "close") return { kind, expectedHandlerId, reason: value };
  return { kind, expectedHandlerId };
}

function ActionButton(props: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      disabled={props.disabled}
      onClick={props.onClick}
    >
      {props.label}
    </Button>
  );
}

type Treatment = ReturnType<typeof usePendencyAction>;
type Can = ReturnType<typeof pendencyActions>;

/** Diálogo da tratativa: `pending` guarda o último pedido mesmo fechado, para o título não trocar na animação de saída. */
function useTreatmentDialog(item: TeamPendencyItem, action: Treatment) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [open, setOpen] = useState(false);
  const kind = pending?.kind ?? "assume";
  return {
    ask(next: DialogKind) {
      setPending({ kind: next, expectedHandlerId: item.handler?.id ?? null });
      setOpen(true);
    },
    props: {
      open,
      title: dialogTitle(kind, item),
      field: DIALOG_FIELD[kind],
      onConfirm(text: string | undefined) {
        if (pending) action.mutate(actionInput(pending, text));
        setOpen(false);
      },
      onCancel: () => setOpen(false),
    },
  };
}

type ButtonsProps = {
  item: TeamPendencyItem;
  can: Can;
  busy: boolean;
  action: Treatment;
  ask: (kind: DialogKind) => void;
};

function TreatmentButtons({ item, can, busy, action, ask }: ButtonsProps) {
  const expectedHandlerId = item.handler?.id ?? null;
  return (
    <>
      {can.assume && (
        <ActionButton
          label="Assumir"
          disabled={busy}
          onClick={() => action.mutate({ kind: "assume", expectedHandlerId })}
        />
      )}
      {can.takeOver && (
        <ActionButton
          label="Assumir de outro"
          disabled={busy}
          onClick={() => ask("assume")}
        />
      )}
      {can.transfer && (
        <PendencyTransferMenu
          id={item.id}
          expectedHandlerId={expectedHandlerId}
          disabled={busy}
          onTransfer={(input) => action.mutate({ kind: "transfer", ...input })}
        />
      )}
      {can.note && (
        <ActionButton
          label="Registrar contato"
          disabled={busy}
          onClick={() => ask("note")}
        />
      )}
      {can.close && (
        <ActionButton
          label="Encerrar sem ciência"
          disabled={busy}
          onClick={() => ask("close")}
        />
      )}
      {can.reopen && (
        <ActionButton
          label="Reabrir a tratativa"
          disabled={busy}
          onClick={() => ask("reopen")}
        />
      )}
    </>
  );
}

/**
 * Ações de tratativa de uma pendência. A mutação é a da pendência (mesma `mutationKey` em toda parte): `busy` vale
 * para qualquer ação dela em voo, também a de um componente que remontou, senão um segundo clique sairia com o
 * `expectedHandlerId` velho e voltaria 409.
 */
function TreatmentActions({ item, me }: Props) {
  const action = usePendencyAction(item.id);
  const inFlight =
    useIsMutating({ mutationKey: [...PENDENCIES_KEY, "action", item.id] }) > 0;
  const busy = action.isPending || inFlight;
  const dialog = useTreatmentDialog(item, action);
  return (
    <>
      <TreatmentButtons
        item={item}
        can={pendencyActions(item, me)}
        busy={busy}
        action={action}
        ask={dialog.ask}
      />
      <PendencyTextDialog {...dialog.props} busy={busy} />
    </>
  );
}

/**
 * O diálogo da ciência manual só lê `recipientId` e `userName`: o resto é o mínimo que o tipo do painel pede (a
 * pendência não traz o estado do envio).
 */
function ackPerson(item: TeamPendencyItem): AlertPerson {
  return {
    recipientId: item.id,
    userName: item.person.name,
    group: item.group,
    status: "SENT",
    eligible: true,
    mayHaveReceived: true,
  };
}

/** Desfazer a ciência manual: o texto de erro é o do painel (`alertActionErrorText`); a lista recarrega em qualquer fim. */
function useUndoAck(item: TeamPendencyItem) {
  const qc = useQueryClient();
  const undo = useUndoManualAck(item.dispatchId);
  const run = async () => {
    try {
      await undo.mutateAsync(item.id);
      toast.success("Ciência manual desfeita");
    } catch (err) {
      toast.error(
        await alertActionErrorText(
          err,
          "Não foi possível desfazer a ciência. Tente de novo.",
        ),
      );
    } finally {
      await invalidatePendencies(qc);
    }
  };
  return { run, busy: undo.isPending };
}

/**
 * Ciência manual pela tela (K2-7, aceite 21): as mesmas regras do painel; o diálogo e os hooks são os dele. O diálogo
 * grava e mostra o erro por conta própria: a lista recarrega quando ele fecha (sucesso ou "Voltar" depois do erro).
 */
function AckActions({ item, me }: Props) {
  const qc = useQueryClient();
  const can = pendencyActions(item, me);
  const [asking, setAsking] = useState<AlertPerson | null>(null);
  const undo = useUndoAck(item);
  return (
    <>
      {can.manualAck && (
        <ActionButton
          label="Registrar ciência manual"
          onClick={() => setAsking(ackPerson(item))}
        />
      )}
      {can.undoManualAck && (
        <ActionButton
          label="Desfazer ciência manual"
          disabled={undo.busy}
          onClick={() => void undo.run()}
        />
      )}
      <ManualAckDialog
        alertId={item.dispatchId}
        person={asking}
        onClose={() => {
          setAsking(null);
          void invalidatePendencies(qc);
        }}
      />
    </>
  );
}

/**
 * Botões das ações da pendência (K2-7, DK20), ao lado dos links da linha. Esconder é a tela; recusar é do servidor
 * (403/404/409/422, com toast e recarga pelos hooks).
 */
export function PendencyActionsBar({ item, me }: Props) {
  const can = pendencyActions(item, me);
  const treats =
    can.assume ||
    can.takeOver ||
    can.transfer ||
    can.note ||
    can.close ||
    can.reopen;
  const acks = can.manualAck || can.undoManualAck;
  return (
    <>
      {treats && <TreatmentActions item={item} me={me} />}
      {acks && <AckActions item={item} me={me} />}
    </>
  );
}
