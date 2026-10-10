import { useNavigate, useRouterState } from '@tanstack/react-router';
import { useForm, type UseFormReturn } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useChangePassword } from '@/features/auth/api';
import { changePasswordSchema, type ChangePasswordInput } from '@/features/auth/schemas';
import { extractApiError } from '@/lib/api-error';
import { Brand } from '@/components/brand';
import { loginDestinationAfterPasswordChange } from '@/lib/auth-navigation';

export function ChangePasswordPage() {
  const navigate = useNavigate();
  const redirectPath = useRouterState({ select: (state) => readRedirect(state.location.search) });
  const changePassword = useChangePassword();
  const form = useForm<ChangePasswordInput>({ resolver: zodResolver(changePasswordSchema) });

  const onSubmit = async (data: ChangePasswordInput) => {
    try {
      await changePassword.mutateAsync({ currentPassword: data.currentPassword, newPassword: data.newPassword });
      toast.success('Senha alterada. Entre novamente com sua nova senha.');
      navigate(loginDestinationAfterPasswordChange(redirectPath));
    } catch (error) {
      const { title, message } = await extractApiError(error);
      toast.error(title, { description: message });
    }
  };

  return <main className="grid min-h-screen place-items-center bg-[var(--canvas)] px-6 py-10"><div className="w-full max-w-[390px] space-y-5"><Brand /><section className="space-y-5 rounded-[10px] border border-[var(--border)] bg-[var(--surface)] p-6 shadow-[var(--shadow-md)] sm:p-7"><div><h2 className="ds-display !text-3xl">Crie uma nova senha.</h2><p className="mt-1 text-sm" style={{ color: 'var(--foreground-muted)' }}>Por segurança, crie uma senha pessoal antes de continuar.</p></div><PasswordForm form={form} onSubmit={onSubmit} pending={changePassword.isPending} /></section></div></main>;
}

function readRedirect(search: unknown) {
  if (!search || typeof search !== 'object') return undefined;
  const value = (search as { redirect?: unknown }).redirect;
  return typeof value === 'string' ? value : undefined;
}

function PasswordForm({ form, onSubmit, pending }: {
  form: UseFormReturn<ChangePasswordInput>;
  onSubmit: (data: ChangePasswordInput) => Promise<void>;
  pending: boolean;
}) {
  const { errors } = form.formState;
  return <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4"><PasswordField label="Senha atual" error={errors.currentPassword?.message} input={form.register('currentPassword')} /><PasswordField label="Nova senha" error={errors.newPassword?.message} hint="Mínimo 8 caracteres." input={form.register('newPassword')} /><PasswordField label="Confirmar nova senha" error={errors.confirmPassword?.message} input={form.register('confirmPassword')} /><Button type="submit" disabled={pending} className="w-full">{pending ? 'Salvando...' : 'Salvar nova senha'}</Button></form>;
}

function PasswordField({ error, hint, input, label }: {
  error?: string;
  hint?: string;
  input: ReturnType<UseFormReturn<ChangePasswordInput>['register']>;
  label: string;
}) {
  return <div className="space-y-1"><Label>{label}</Label><Input type="password" {...input} />{hint && <p className="text-xs" style={{ color: 'var(--foreground-muted)' }}>{hint}</p>}{error && <p className="text-xs text-destructive">{error}</p>}</div>;
}
