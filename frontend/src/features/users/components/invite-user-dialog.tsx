import { useEffect, useState } from 'react';
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
import { useInviteUser } from '../api';
import { inviteUserSchema, type InviteUserOutput } from '../schemas';
import { TemporaryPasswordModal } from './temporary-password-modal';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

const EMPTY_INVITE: InviteUserOutput = { email: '', name: '', role: 'OPERATOR' };

export function InviteUserDialog({ open, onOpenChange }: Props) {
  const invite = useInviteUser();
  const [tmpPwd, setTmpPwd] = useState<string | null>(null);
  const form = useForm<InviteUserOutput>({
    resolver: zodResolver(inviteUserSchema) as never,
    defaultValues: EMPTY_INVITE,
  });

  // Reset to empty defaults whenever the dialog (re)opens, so a previous
  // cancel/submit never leaves stale email/name/role behind on the next open.
  useEffect(() => {
    if (open) form.reset(EMPTY_INVITE);
  }, [open, form]);

  const onSubmit = async (data: InviteUserOutput) => {
    try {
      const result = await invite.mutateAsync(data);
      setTmpPwd(result.temporaryPassword);
      form.reset(EMPTY_INVITE);
      onOpenChange(false);
    } catch (err) {
      const { title, message } = await extractApiError(err);
      toast.error(title, { description: message });
    }
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Convidar usuário</DialogTitle>
          </DialogHeader>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 py-2">
            <div className="space-y-1">
              <Label>Email</Label>
              <Input type="email" {...form.register('email')} />
              {form.formState.errors.email && (
                <p className="text-xs text-destructive">{form.formState.errors.email.message}</p>
              )}
            </div>
            <div className="space-y-1">
              <Label>Nome (opcional)</Label>
              <Input {...form.register('name')} />
            </div>
            <div className="space-y-1">
              <Label>Perfil</Label>
              <Select
                value={form.watch('role')}
                onValueChange={(v) =>
                  form.setValue('role', v as 'ADMIN' | 'OPERATOR')
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="OPERATOR">Operador</SelectItem>
                  <SelectItem value="ADMIN">Admin</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                Cancelar
              </Button>
              <Button type="submit" disabled={invite.isPending}>
                {invite.isPending ? 'Convidando...' : 'Convidar'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {tmpPwd && (
        <TemporaryPasswordModal
          password={tmpPwd}
          onClose={() => setTmpPwd(null)}
        />
      )}
    </>
  );
}
