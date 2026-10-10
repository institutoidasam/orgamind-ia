import { createFileRoute, useNavigate, redirect } from '@tanstack/react-router';
import { useForm, type UseFormReturn } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { HTTPError } from 'ky';
import { toast } from 'sonner';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useLogin } from '@/features/auth/api';
import { loginInputSchema, type LoginInput } from '@/features/auth/schemas';
import { useAuthStore } from '@/stores/auth.store';
import { Brand } from '@/components/brand';

const loginSearchSchema = z.object({
  redirect: z.string().optional(),
});
const route = createFileRoute('/login')({
  validateSearch: loginSearchSchema,
  beforeLoad: () => {
    if (useAuthStore.getState().accessToken) {
      throw redirect({ to: '/dashboard' });
    }
  },
  component: LoginPage,
});
export { route as Route };

function LoginPage() {
  const navigate = useNavigate();
  const search = route.useSearch();
  const form = useForm<LoginInput>({ resolver: zodResolver(loginInputSchema) });
  const login = useLogin();

  const onSubmit = async (input: LoginInput) => {
    try {
      await login.mutateAsync(input);
      const safeRedirect = getSafeRedirect(search.redirect);
      if (useAuthStore.getState().mustChangePassword) {
        navigate({ to: '/change-password', search: { redirect: safeRedirect } });
        return;
      }
      navigate({ to: safeRedirect });
    } catch (error) {
      notifyLoginError(error);
    }
  };

  return (
    <div className="grid min-h-screen lg:grid-cols-2" style={{ background: 'var(--canvas)' }}>
      <LoginBrandPanel />
      <LoginCard form={form} isPending={login.isPending} onSubmit={onSubmit} />
    </div>
  );
}

function LoginBrandPanel() {
  return (
    <div className="relative hidden flex-col justify-between p-14 text-white lg:flex" style={{ background: 'var(--brand-navy)' }}>
      <Brand inverse />
      <div className="max-w-[560px]">
        <p className="mb-5 text-xs font-semibold uppercase tracking-[0.14em] text-[#adbdd1]">Ambiente interno</p>
        <h1 className="text-[clamp(40px,5vw,72px)] font-extrabold leading-[0.98] tracking-[-0.04em]">
          Comunicação <span className="font-normal text-[#adbdd1]">entre setores</span>
        </h1>
        <p className="mt-6 max-w-md text-base leading-7 text-[#d7e0eb]">Organize demandas, comunicados e decisões da sua equipe em um só lugar.</p>
      </div>
      <div className="text-xs uppercase tracking-[0.08em] text-[#adbdd1]">GBR Componentes</div>
    </div>
  );
}

function LoginCard({ form, isPending, onSubmit }: { form: UseFormReturn<LoginInput>; isPending: boolean; onSubmit: (input: LoginInput) => Promise<void> }) {
  return (
    <div className="flex items-center justify-center px-6 py-12" style={{ background: 'var(--surface)' }}>
      <div className="w-full max-w-[360px] space-y-5 rounded-lg border p-6" style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}>
        <div className="lg:hidden"><Brand /></div>
        <div>
          <h2 className="ds-display !text-3xl">Bem-vindo de volta.</h2>
          <p className="mt-1 text-sm" style={{ color: 'var(--foreground-muted)' }}>Entre com suas credenciais para continuar.</p>
        </div>
        <LoginForm form={form} isPending={isPending} onSubmit={onSubmit} />
      </div>
    </div>
  );
}

function LoginForm({ form, isPending, onSubmit }: { form: UseFormReturn<LoginInput>; isPending: boolean; onSubmit: (input: LoginInput) => Promise<void> }) {
  const { errors } = form.formState;
  return (
    <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
      <LoginField label="Email" type="email" error={errors.email?.message} registration={form.register('email')} />
      <LoginField label="Senha" type="password" error={errors.password?.message} registration={form.register('password')} />
      <Button type="submit" disabled={isPending} className="w-full">{isPending ? 'Entrando...' : 'Entrar'}</Button>
    </form>
  );
}

function LoginField({ label, type, error, registration }: { label: string; type: 'email' | 'password'; error?: string; registration: ReturnType<UseFormReturn<LoginInput>['register']> }) {
  const id = type;
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} type={type} {...registration} />
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

function getSafeRedirect(requested: string | undefined) {
  return requested?.startsWith('/') && !requested.startsWith('//') ? requested : '/dashboard';
}

function notifyLoginError(error: unknown) {
  if (!(error instanceof HTTPError)) {
    toast.error('Erro de rede. Verifique sua conexão.');
    return;
  }
  if (error.response.status === 401) toast.error('Credenciais inválidas');
  else if (error.response.status === 429) toast.error('Muitas tentativas. Aguarde alguns minutos.');
  else if (error.response.status >= 500) toast.error('Erro do servidor. Tente novamente.');
  else toast.error('Erro ao entrar.');
}
