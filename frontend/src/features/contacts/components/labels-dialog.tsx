import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { useWhatsappLabels } from '@/features/whatsapp/api';
import { useSetContactLabels } from '../api';
import type { Contact } from '../schemas';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contact: Contact | null;
};

/**
 * Per-contact label picker. Pulls the available labels from the connected
 * WhatsApp Business account and lets the operator check/uncheck which apply
 * to the selected contact. The save call goes through `POST
 * /contacts/:id/labels` which on the backend computes the diff and pushes
 * each `add`/`remove` to Evolution before mirroring locally.
 *
 * If the WhatsApp account has no labels, we surface that explicitly —
 * labels are a WA Business feature that has to be created inside the
 * WhatsApp app first; ORGAMIND only consumes them.
 */
export function LabelsDialog({ open, onOpenChange, contact }: Props) {
  const labelsQuery = useWhatsappLabels();
  const save = useSetContactLabels();
  const qc = useQueryClient();
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Reset selection from contact every time we (re)open the dialog.
  useEffect(() => {
    if (!open) return;
    setSelected(new Set(contact?.waLabels ?? []));
  }, [open, contact]);

  const toggle = (id: string, checked: boolean | 'indeterminate') => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked === true) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const onSave = async () => {
    if (!contact) return;
    try {
      await save.mutateAsync({
        id: contact.id,
        labelIds: [...selected],
      });
      toast.success('Etiquetas atualizadas');
      onOpenChange(false);
    } catch {
      // The backend reconciles the diff label-by-label through Evolution and
      // can persist part of it before throwing, so the local cache (and the
      // contact's mirrored labels) may be partially up to date. The mutation's
      // own `onSuccess` invalidation never runs on this path, so refresh here.
      toast.error(
        'As etiquetas podem ter sido parcialmente aplicadas — verifique se o WhatsApp está conectado e confira a lista.',
      );
    } finally {
      qc.invalidateQueries({ queryKey: ['contacts'] });
    }
  };

  const canSave = Boolean(contact) && !save.isPending && !labelsQuery.isLoading;

  // Body is a small state machine — loading → error → empty → list — rendered
  // with guard clauses so each branch reads top-to-bottom instead of nesting
  // inside a ternary ladder.
  const renderLabelsBody = () => {
    if (labelsQuery.isLoading) {
      return <p className="text-sm text-muted-foreground">Carregando…</p>;
    }

    if (labelsQuery.isError) {
      return (
        <p className="text-sm text-destructive">
          Não foi possível carregar as etiquetas. O WhatsApp precisa estar
          conectado e o provedor precisa ser Evolution.
        </p>
      );
    }

    const labels = labelsQuery.data ?? [];
    if (labels.length === 0) {
      return (
        <p className="text-sm text-muted-foreground">
          Nenhuma etiqueta configurada na sua conta WhatsApp Business.
          Crie etiquetas dentro do app do WhatsApp e elas aparecerão aqui.
        </p>
      );
    }

    return (
      <ul className="max-h-[320px] space-y-2 overflow-y-auto">
        {labels.map((l) => (
          <li key={l.id}>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={selected.has(l.id)}
                onCheckedChange={(v) => toggle(l.id, v)}
              />
              <span>{l.name}</span>
              <span
                className="ml-auto text-xs text-muted-foreground"
                title={`Cor #${l.color}`}
              >
                #{l.color}
              </span>
            </label>
          </li>
        ))}
      </ul>
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            Etiquetas — {contact?.name ?? contact?.phoneE164 ?? ''}
          </DialogTitle>
        </DialogHeader>

        {renderLabelsBody()}

        <DialogFooter className="pt-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={save.isPending}
          >
            Cancelar
          </Button>
          <Button type="button" disabled={!canSave} onClick={onSave}>
            {save.isPending ? 'Salvando…' : 'Salvar'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
