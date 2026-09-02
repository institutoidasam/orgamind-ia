import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useCreateSegment } from '@/features/segments/api';
import type { CreateSegment, SegmentDetail } from '@/features/segments/schemas';
import type { FilterGroup } from '../schemas';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The current audience filters to persist as a new segment. */
  filters: FilterGroup;
  /** Called with the created segment after a successful save. */
  onSaved?: (segment: SegmentDetail) => void;
};

/**
 * "Salvar como segmento": persist the wizard's current FilterGroup as a brand-new
 * named segment. Mirrors the SegmentEditor description rule — a blank description
 * is sent as `undefined` (omitted) for a new segment, never `null`.
 */
export function SaveAsSegmentDialog({
  open,
  onOpenChange,
  filters,
  onSaved,
}: Props) {
  const create = useCreateSegment();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');

  // Reset the form whenever the dialog reopens so a previous attempt's text
  // doesn't leak into the next save.
  useEffect(() => {
    if (open) {
      setName('');
      setDescription('');
    }
  }, [open]);

  const handleSave = async () => {
    const trimmedName = name.trim();
    if (!trimmedName) return;
    const trimmedDescription = description.trim();
    try {
      const segment = await create.mutateAsync({
        name: trimmedName,
        // Brand-new segment with no description → omit it (undefined), never
        // null. See segment-editor.tsx.
        description: trimmedDescription ? trimmedDescription : undefined,
        filters,
      } as CreateSegment);
      toast.success('Segmento salvo');
      onSaved?.(segment);
      onOpenChange(false);
    } catch {
      toast.error('Erro ao salvar segmento');
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Salvar como segmento</DialogTitle>
          <DialogDescription>
            Salve os filtros atuais como um segmento reutilizável.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="save-segment-name">Nome</Label>
            <Input
              id="save-segment-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Ex: VIP de Manaus"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="save-segment-description">Descrição (opcional)</Label>
            <Textarea
              id="save-segment-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Para que serve este segmento?"
            />
          </div>
          <p className="text-xs text-muted-foreground">
            Os filtros atuais serão salvos. O segmento resolve seus contatos
            dinamicamente a cada uso.
          </p>
        </div>
        <DialogFooter className="pt-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={create.isPending}
          >
            Cancelar
          </Button>
          <Button
            type="button"
            onClick={handleSave}
            disabled={!name.trim() || create.isPending}
          >
            {create.isPending ? 'Salvando…' : 'Salvar'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
