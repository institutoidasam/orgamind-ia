import { createFileRoute, useNavigate, redirect } from '@tanstack/react-router';
import { useForm } from 'react-hook-form';
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
import logoSvg from '@/assets/logo.svg';

const loginSearchSchema = z.object({
  redirect: z.string().optional(),
});

export const Route = createFileRoute('/login')({
  validateSearch: loginSearchSchema,
  beforeLoad: () => {
    if (useAuthStore.getState().accessToken) {
      throw redirect({ to: '/dashboard' });
    }
  },
  component: LoginPage,
});

function LoginPage() {
  const navigate = useNavigate();
  const search = Route.useSearch();
  const form = useForm<LoginInput>({ resolver: zodResolver(loginInputSchema) });
  const login = useLogin();

  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      <div
        className="relative hidden flex-col justify-between p-14 text-white lg:flex"
        style={{ background: 'var(--gradient-brand)' }}
      >
        <div className="flex items-center gap-2 text-xl font-bold tracking-tight">
          <img src={logoSvg} alt="" className="size-7 brightness-0 invert" aria-hidden />
          ORGAMIND
        </div>
        <h1 className="text-[clamp(40px,5vw,72px)] font-extrabold leading-[0.98] tracking-[-0.04em]">
          Mensagens em <span className="font-normal opacity-65">massa,</span><br />
          uma a uma.
        </h1>
        <div className="text-xs uppercase tracking-[0.08em] opacity-75">
          Painel do operador
        </div>
      </div>
      <div className="flex items-center justify-center px-6 py-12">
        <div className="w-full max-w-[360px] space-y-5">
          <div>
            <h2 className="ds-display !text-3xl">Bem-vindo de volta.</h2>
            <p className="mt-1 text-sm" style={{ color: 'var(--foreground-muted)' }}>
              Entre com suas credenciais para continuar.
            </p>
          </div>
          <form
            onSubmit={form.handleSubmit(async (d) => {
              try {
                await login.mutateAsync(d);
                // Reject absolute URLs and protocol-relative `//host` to block
                // open-redirect via `?redirect=https://evil.com`. Only same-app
                // paths are allowed.
                const requested = search.redirect;
                const safe =
                  requested && requested.startsWith('/') && !requested.startsWith('//')
                    ? requested
                    : '/dashboard';
                const { mustChangePassword } = useAuthStore.getState();
                if (mustChangePassword) {
                  navigate({ to: '/change-password', search: { redirect: safe } });
                } else {
                  navigate({ to: safe });
                }
              } catch (err) {
                if (err instanceof HTTPError) {
                  if (err.response.status === 401) toast.error('Credenciais inválidas');
                  else if (err.response.status === 429)
                    toast.error('Muitas tentativas. Aguarde alguns minutos.');
                  else if (err.response.status >= 500)
                    toast.error('Erro do servidor. Tente novamente.');
                  else toast.error('Erro ao entrar.');
                } else {
                  toast.error('Erro de rede. Verifique sua conexão.');
                }
              }
            })}
            className="space-y-4"
          >
            <div className="space-y-1">
              <Label htmlFor="email">Email</Label>
              <Input id="email" type="email" {...form.register('email')} />
              {form.formState.errors.email && (
                <p className="text-xs text-destructive">
                  {form.formState.errors.email.message}
                </p>
              )}
            </div>
            <div className="space-y-1">
              <Label htmlFor="password">Senha</Label>
              <Input id="password" type="password" {...form.register('password')} />
              {form.formState.errors.password && (
                <p className="text-xs text-destructive">
                  {form.formState.errors.password.message}
                </p>
              )}
            </div>
            <Button type="submit" disabled={login.isPending} className="w-full">
              {login.isPending ? 'Entrando...' : 'Entrar'}
            </Button>
          </form>
        </div>
      </div>
    </div>
  );
}
