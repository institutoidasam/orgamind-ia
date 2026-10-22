import { useEffect } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useCreateLevel, useUpdateLevel } from '../api';
import { describeLevelError, LEVEL_NAME_TAKEN_CODE } from '../error-messages';
import { levelFormSchema, type CreateLevelInput, type LevelAdmin } from '../schemas';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Ausente = nível novo. */
  level?: LevelAdmin;
};

function useLevelForm({ open, onOpenChange, level }: Props) {
  const create = useCreateLevel();
  const update = useUpdateLevel();
  const form = useForm<CreateLevelInput>({
    resolver: zodResolver(levelFormSchema),
    defaultValues: { name: level?.name ?? '' },
  });
  useEffect(() => {
    if (open) form.reset({ name: level?.name ?? '' });
  }, [open, level, form]);
  const submit = async (data: CreateLevelInput) => {
    try {
      await (level ? update.mutateAsync({ id: level.id, ...data }) : create.mutateAsync(data));
      onOpenChange(false);
    } catch (error) {
      const { code, message } = await describeLevelError(error);
      if (code === LEVEL_NAME_TAKEN_CODE) form.setError('name', { message });
      else toast.error(message);
    }
  };
  return { form, submit, pending: create.isPending || update.isPending };
}

export function LevelFormDialog(props: Props) {
  const { form, submit, pending } = useLevelForm(props);
  const nameError = form.formState.errors.name;
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{props.level ? 'Editar nível' : 'Novo nível'}</DialogTitle>
        </DialogHeader>
        <form onSubmit={form.handleSubmit(submit)} className="space-y-4 py-2">
          <div className="space-y-1">
            <Label htmlFor="level-name">Nome</Label>
            <Input id="level-name" maxLength={40} {...form.register('name')} />
            {nameError && <p className="text-xs text-destructive">{nameError.message}</p>}
          </div>
          <DialogFooter>
            <Button variant="ghost" type="button" onClick={() => props.onOpenChange(false)}>Cancelar</Button>
            <Button disabled={pending}>{pending ? 'Salvando…' : 'Salvar'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
