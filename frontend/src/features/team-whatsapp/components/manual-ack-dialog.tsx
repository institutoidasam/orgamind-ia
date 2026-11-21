import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { alertActionErrorText, useManualAck } from "../alert-actions-api";
import type { AlertPerson } from "../alert-schemas";

/** A observação da ciência manual, aparada, tem de 1 a 200 caracteres (CI6, I5). */
export const NOTE_MAX_LENGTH = 200;

const SAVE_FALLBACK = "Não foi possível registrar a ciência. Tente de novo.";

type FormProps = { alertId: string; person: AlertPerson; onClose: () => void };

/** Estado do formulário: a observação, o erro do servidor e o envio. Só envia a observação já aparada. */
function useAckForm({ alertId, person, onClose }: FormProps) {
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const ack = useManualAck(alertId);
  const length = note.trim().length;
  const valid = length >= 1 && length <= NOTE_MAX_LENGTH;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!valid) return;
    setError(null);
    try {
      await ack.mutateAsync({
        recipientId: person.recipientId,
        note: note.trim(),
      });
      toast.success("Ciência registrada");
      onClose();
    } catch (err) {
      setError(await alertActionErrorText(err, SAVE_FALLBACK));
    }
  };
  return { note, setNote, error, length, valid, submit, busy: ack.isPending };
}

function AckForm(props: FormProps) {
  const form = useAckForm(props);
  return (
    <form onSubmit={form.submit} className="space-y-4">
      <DialogHeader>
        <DialogTitle>Registrar ciência</DialogTitle>
        <DialogDescription>
          {props.person.userName}: use quando a pessoa confirmou por outro meio.
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-1">
        <Label htmlFor="manual-ack-note">Observação</Label>
        <Textarea
          id="manual-ack-note"
          value={form.note}
          onChange={(e) => form.setNote(e.target.value)}
          placeholder="Ex.: confirmou por ligação"
        />
        <p
          className="text-xs text-muted-foreground"
          aria-live="polite"
        >{`${form.length}/${NOTE_MAX_LENGTH}`}</p>
        {form.length > NOTE_MAX_LENGTH && (
          <p className="text-sm">{`Use no máximo ${NOTE_MAX_LENGTH} caracteres.`}</p>
        )}
      </div>
      {form.error && (
        <p role="alert" className="text-sm">
          {form.error}
        </p>
      )}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={props.onClose}>
          Voltar
        </Button>
        <Button type="submit" disabled={!form.valid || form.busy}>
          Registrar ciência
        </Button>
      </DialogFooter>
    </form>
  );
}

type Props = {
  alertId: string;
  /** A pessoa cuja ciência se registra; `null` = diálogo fechado. */
  person: AlertPerson | null;
  onClose: () => void;
};

/**
 * Ciência manual (I5): observação obrigatória de até 200 caracteres. Mostra ou esconde a ação; a recusa (chave, ciência
 * já registrada) é do servidor.
 */
export function ManualAckDialog({ alertId, person, onClose }: Props) {
  return (
    <Dialog
      open={person !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        {person && (
          <AckForm
            key={person.recipientId}
            alertId={alertId}
            person={person}
            onClose={onClose}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
