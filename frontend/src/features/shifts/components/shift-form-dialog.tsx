import { useEffect } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm, type UseFormReturn } from 'react-hook-form';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useCreateShift, useUpdateShift } from '../api';
import { describeShiftError, SHIFT_NAME_TAKEN_CODE } from '../error-messages';
import { shiftFormSchema, type CreateShiftInput, type ShiftAdmin } from '../schemas';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Ausente = turno novo. */
  shift?: ShiftAdmin;
};

const EMPTY_SHIFT: CreateShiftInput = { name: '', startTime: '', endTime: '' };

function initialValues(shift?: ShiftAdmin): CreateShiftInput {
  if (!shift) return EMPTY_SHIFT;
  return { name: shift.name, startTime: shift.startTime, endTime: shift.endTime };
}

function useShiftForm({ open, onOpenChange, shift }: Props) {
  const create = useCreateShift();
  const update = useUpdateShift();
  const form = useForm<CreateShiftInput>({
    resolver: zodResolver(shiftFormSchema),
    defaultValues: initialValues(shift),
  });
  useEffect(() => {
    if (open) form.reset(initialValues(shift));
  }, [open, shift, form]);
  const submit = async (data: CreateShiftInput) => {
    try {
      await (shift ? update.mutateAsync({ id: shift.id, ...data }) : create.mutateAsync(data));
      onOpenChange(false);
    } catch (error) {
      const { code, message } = await describeShiftError(error);
      if (code === SHIFT_NAME_TAKEN_CODE) form.setError('name', { message });
      else toast.error(message);
    }
  };
  return { form, submit, pending: create.isPending || update.isPending };
}

export function ShiftFormDialog(props: Props) {
  const { form, submit, pending } = useShiftForm(props);
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{props.shift ? 'Editar turno' : 'Novo turno'}</DialogTitle>
        </DialogHeader>
        <form onSubmit={form.handleSubmit(submit)} className="space-y-4 py-2">
          <ShiftFields form={form} />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => props.onOpenChange(false)}>
              Cancelar
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? 'Salvando...' : 'Salvar'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ShiftFields({ form }: { form: UseFormReturn<CreateShiftInput> }) {
  const { errors } = form.formState;
  return (
    <>
      <div className="space-y-1">
        <Label htmlFor="shift-name">Nome</Label>
        <Input id="shift-name" maxLength={40} {...form.register('name')} />
        {errors.name && <p className="text-xs text-destructive">{errors.name.message}</p>}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label htmlFor="shift-start">Início</Label>
          <Input id="shift-start" type="time" {...form.register('startTime')} />
          {errors.startTime && <p className="text-xs text-destructive">{errors.startTime.message}</p>}
        </div>
        <div className="space-y-1">
          <Label htmlFor="shift-end">Fim</Label>
          <Input id="shift-end" type="time" {...form.register('endTime')} />
          {errors.endTime && <p className="text-xs text-destructive">{errors.endTime.message}</p>}
        </div>
      </div>
    </>
  );
}
