import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { extractApiError } from '@/lib/api-error';
import { useUpdateUser } from '../api';
import { editUserSchema, type EditUserInput, type UserSummary } from '../schemas';

type Props = {
  user: UserSummary;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isSelf: boolean;
};

export function EditUserDialog({ user, open, onOpenChange, isSelf }: Props) {
  const update = useUpdateUser();
  const form = useForm<EditUserInput>({ resolver: zodResolver(editUserSchema) });

  useEffect(() => {
    form.reset({ name: user.name ?? '', role: user.role });
  }, [user, form]);

  const onSubmit = async (data: EditUserInput) => {
    try {
      await update.mutateAsync({ id: user.id, data });
      toast.success('Usuário atualizado.');
      onOpenChange(false);
    } catch (err) {
      const { title, message } = await extractApiError(err);
      toast.error(title, { description: message });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Editar usuário</DialogTitle>
        </DialogHeader>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 py-2">
          <div className="space-y-1">
            <Label>Email (não editável)</Label>
            <Input value={user.email} disabled />
          </div>
          <div className="space-y-1">
            <Label>Nome</Label>
            <Input {...form.register('name')} />
          </div>
          <div className="space-y-1">
            <Label>Perfil</Label>
            <Select
              value={form.watch('role')}
              onValueChange={(v) => form.setValue('role', v as 'ADMIN' | 'OPERATOR')}
              disabled={isSelf}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="OPERATOR">Operador</SelectItem>
                <SelectItem value="ADMIN">Admin</SelectItem>
              </SelectContent>
            </Select>
            {isSelf && (
              <p className="text-xs" style={{ color: 'var(--foreground-muted)' }}>
                Você não pode alterar seu próprio perfil.
              </p>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button type="submit" disabled={update.isPending}>
              {update.isPending ? 'Salvando...' : 'Salvar'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
