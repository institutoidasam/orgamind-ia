import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

const NOTE_MAX = 200;

type Props = {
  open: boolean;
  title: string;
  /** Observação já sem espaços nas pontas; `undefined` quando vazia (nada é enviado). */
  onConfirm: (note: string | undefined) => void;
  onCancel: () => void;
};

/** Diálogo de observação (DK15/DK16): título da ação, "Observação (opcional)" até 200, "Cancelar" e "Confirmar". */
export function ConversationActionDialog({ open, title, onConfirm, onCancel }: Props) {
  const [note, setNote] = useState('');

  function close() {
    setNote('');
    onCancel();
  }

  function confirm() {
    const value = note.trim();
    setNote('');
    onConfirm(value || undefined);
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) close(); }}>
      <DialogContent showCloseButton={false} aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-2">
          <Label htmlFor="conversation-action-note">Observação (opcional)</Label>
          <Textarea
            id="conversation-action-note"
            maxLength={NOTE_MAX}
            value={note}
            onChange={(e) => setNote(e.target.value.slice(0, NOTE_MAX))}
          />
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={close}>Cancelar</Button>
          <Button type="button" onClick={confirm}>Confirmar</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
