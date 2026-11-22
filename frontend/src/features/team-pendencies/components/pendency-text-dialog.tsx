import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

/** O texto de uma ação da pendência (observação, contato, motivo) vai até 200 caracteres (DK11, DK13, DK14). */
export const PENDENCY_TEXT_MAX = 200;

const FIELD_ID = "pendency-dialog-text";

export type PendencyTextField = { label: string; required: boolean };

type Props = {
  open: boolean;
  title: string;
  /** Campo de texto; sem ele o diálogo é só uma confirmação ("Transferir para {nome}?", "Reabrir a tratativa?"). */
  field?: PendencyTextField;
  /** Ação em andamento: "Confirmar" fica desligado. */
  busy?: boolean;
  /** Texto já aparado; `undefined` quando vazio ou sem campo (nada é enviado). */
  onConfirm: (text: string | undefined) => void;
  onCancel: () => void;
};

type FormProps = Omit<Props, "open">;

/** O formulário vive dentro do conteúdo do diálogo: fechar o desmonta e o texto digitado não sobra para a próxima. */
function TextForm({
  title,
  field,
  busy = false,
  onConfirm,
  onCancel,
}: FormProps) {
  const [text, setText] = useState("");
  const value = text.trim();
  const blocked = busy || (field?.required === true && value === "");
  return (
    <>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
      </DialogHeader>
      {field && (
        <div className="grid gap-2">
          <Label htmlFor={FIELD_ID}>{field.label}</Label>
          <Textarea
            id={FIELD_ID}
            maxLength={PENDENCY_TEXT_MAX}
            value={text}
            onChange={(e) =>
              setText(e.target.value.slice(0, PENDENCY_TEXT_MAX))
            }
          />
        </div>
      )}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancelar
        </Button>
        <Button
          type="button"
          disabled={blocked}
          onClick={() => onConfirm(value || undefined)}
        >
          Confirmar
        </Button>
      </DialogFooter>
    </>
  );
}

/**
 * Diálogo das ações da pendência (DK20): título da ação, campo opcional ou obrigatório de até 200 caracteres, e
 * "Cancelar"/"Confirmar". "Confirmar" fica desligado com campo obrigatório vazio e durante o envio.
 */
export function PendencyTextDialog({ open, onCancel, ...form }: Props) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <DialogContent showCloseButton={false} aria-describedby={undefined}>
        <TextForm {...form} onCancel={onCancel} />
      </DialogContent>
    </Dialog>
  );
}
