import { createFileRoute, useNavigate, redirect } from '@tanstack/react-router';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useChangePassword } from '@/features/auth/api';
import { changePasswordSchema, type ChangePasswordInput } from '@/features/auth/schemas';
import { useAuthStore } from '@/stores/auth.store';
import { extractApiError } from '@/lib/api-error';

const searchSchema = z.object({
  redirect: z.string().optional(),
});

export const Route = createFileRoute('/change-password')({
  validateSearch: searchSchema,
  beforeLoad: () => {
    if (!useAuthStore.getState().accessToken) {
      throw redirect({ to: '/login' });
    }
  },
  component: ChangePasswordPage,
});

function ChangePasswordPage() {
  const navigate = useNavigate();
  const search = Route.useSearch();
  const changePwd = useChangePassword();
  const form = useForm<ChangePasswordInput>({ resolver: zodResolver(changePasswordSchema) });

  const onSubmit = async (data: ChangePasswordInput) => {
    try {
      await changePwd.mutateAsync({
        currentPassword: data.currentPassword,
        newPassword: data.newPassword,
      });
      toast.success('Senha alterada com sucesso!');
      const safe =
        search.redirect && search.redirect.startsWith('/') && !search.redirect.startsWith('//')
          ? search.redirect
          : '/dashboard';
      navigate({ to: safe });
    } catch (err) {
      const { title, message } = await extractApiError(err);
      toast.error(title, { description: message });
    }
  };

  return (
    <div className="grid min-h-screen place-items-center px-6">
      <div className="w-full max-w-[360px] space-y-5">
        <div>
          <h2 className="ds-display !text-3xl">Crie uma nova senha.</h2>
          <p className="mt-1 text-sm" style={{ color: 'var(--foreground-muted)' }}>
            Por segurança, crie uma senha pessoal antes de continuar.
          </p>
        </div>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          <div className="space-y-1">
            <Label>Senha atual</Label>
            <Input type="password" {...form.register('currentPassword')} />
            {form.formState.errors.currentPassword && (
              <p className="text-xs text-destructive">
                {form.formState.errors.currentPassword.message}
              </p>
            )}
          </div>
          <div className="space-y-1">
            <Label>Nova senha</Label>
            <Input type="password" {...form.register('newPassword')} />
            <p className="text-xs" style={{ color: 'var(--foreground-muted)' }}>
              Mínimo 8 caracteres.
            </p>
            {form.formState.errors.newPassword && (
              <p className="text-xs text-destructive">
                {form.formState.errors.newPassword.message}
              </p>
            )}
          </div>
          <div className="space-y-1">
            <Label>Confirmar nova senha</Label>
            <Input type="password" {...form.register('confirmPassword')} />
            {form.formState.errors.confirmPassword && (
              <p className="text-xs text-destructive">
                {form.formState.errors.confirmPassword.message}
              </p>
            )}
          </div>
          <Button type="submit" disabled={changePwd.isPending} className="w-full">
            {changePwd.isPending ? 'Salvando...' : 'Salvar nova senha'}
          </Button>
        </form>
      </div>
    </div>
  );
}
