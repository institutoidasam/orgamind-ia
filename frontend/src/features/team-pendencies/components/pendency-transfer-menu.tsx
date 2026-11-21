import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { usePendencyHandlers } from "../api";
import { PendencyTextDialog } from "./pendency-text-dialog";

type Target = { id: string; name: string };

/** Destino escolhido com o responsável que a tela mostrava na escolha: segue no pedido mesmo que a lista recarregue. */
type Picked = Target & { expectedHandlerId: string | null };

/** O que a transferência leva: o destino e o responsável que a tela mostrava na escolha (DK12). */
export type PendencyTransferInput = {
  toUserId: string;
  expectedHandlerId: string | null;
};

type Props = {
  /** Id da pendência (a rota `pendencies/:id/handlers`). */
  id: string;
  /** Responsável mostrado na linha: vai como `expectedHandlerId` e fica fora da lista. */
  expectedHandlerId: string | null;
  /** Alguma ação desta pendência em andamento: o gatilho fica desligado. */
  disabled: boolean;
  onTransfer: (input: PendencyTransferInput) => void;
};

type DestinationsProps = {
  options: Target[];
  state: "loading" | "failed" | "ready";
  onPick: (target: Target) => void;
};

const NOTICE: Record<"loading" | "failed", string> = {
  loading: "Carregando…",
  failed: "Não foi possível carregar a lista.",
};

function destinationsState(query: {
  isError: boolean;
  isPending: boolean;
}): DestinationsProps["state"] {
  if (query.isError) return "failed";
  return query.isPending ? "loading" : "ready";
}

function Destinations({ options, state, onPick }: DestinationsProps) {
  if (state !== "ready")
    return <DropdownMenuItem disabled>{NOTICE[state]}</DropdownMenuItem>;
  if (options.length === 0)
    return <DropdownMenuItem disabled>Ninguém disponível.</DropdownMenuItem>;
  return options.map((option) => (
    <DropdownMenuItem key={option.id} onSelect={() => onPick(option)}>
      {option.name}
    </DropdownMenuItem>
  ));
}

/** Escolha do destino e o diálogo de confirmação; `picked` guarda a última escolha para o título não trocar na saída. */
function useTransferPick(
  expectedHandlerId: string | null,
  onTransfer: Props["onTransfer"],
) {
  const [picked, setPicked] = useState<Picked | null>(null);
  const [asking, setAsking] = useState(false);
  return {
    picked,
    asking,
    pick(target: Target) {
      setPicked({ ...target, expectedHandlerId });
      setAsking(true);
    },
    confirm() {
      if (picked)
        onTransfer({
          toUserId: picked.id,
          expectedHandlerId: picked.expectedHandlerId,
        });
      setAsking(false);
    },
    cancel: () => setAsking(false),
  };
}

/**
 * "Transferir" (DK12, DK20): os destinos vêm de `GET pendencies/:id/handlers` (quem pode receber a pendência), sem o
 * responsável atual. Escolher uma pessoa abre "Transferir para {nome}?" com "Cancelar"/"Confirmar".
 */
export function PendencyTransferMenu({
  id,
  expectedHandlerId,
  disabled,
  onTransfer,
}: Props) {
  const [open, setOpen] = useState(false);
  const handlers = usePendencyHandlers(id, open);
  const transfer = useTransferPick(expectedHandlerId, onTransfer);
  const options = (handlers.data?.items ?? []).filter(
    (handler) => handler.id !== expectedHandlerId,
  );
  return (
    <>
      <DropdownMenu open={open} onOpenChange={setOpen} modal={false}>
        <DropdownMenuTrigger asChild>
          <Button type="button" size="sm" variant="outline" disabled={disabled}>
            Transferir
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuLabel>Transferir para</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <Destinations
            options={options}
            state={destinationsState(handlers)}
            onPick={transfer.pick}
          />
        </DropdownMenuContent>
      </DropdownMenu>
      <PendencyTextDialog
        open={transfer.asking}
        title={`Transferir para ${transfer.picked?.name ?? ""}?`}
        onConfirm={transfer.confirm}
        onCancel={transfer.cancel}
      />
    </>
  );
}
