import { createFileRoute, Outlet, redirect, useRouter, useRouterState } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { onSessionExpired, useAuthStore } from '@/stores/auth.store';
import { logoutRemote } from '@/lib/api-client';
import { AppShell } from '@/components/layout/app-shell';
import { Sidebar } from '@/components/layout/sidebar';
import { Topbar } from '@/components/layout/topbar';
import { Footer } from '@/components/layout/footer';
import { CommandPalette } from '@/components/command-palette';
import { ProviderScopeProvider } from '@/features/whatsapp/provider-scope';

export const Route = createFileRoute('/_authenticated')({
  beforeLoad: ({ location }) => {
    const { accessToken, mustChangePassword } = useAuthStore.getState();
    if (!accessToken) {
      throw redirect({
        to: '/login',
        search: { redirect: location.pathname + location.searchStr },
      });
    }
    // Força troca de senha antes de qualquer rota autenticada
    if (mustChangePassword && location.pathname !== '/change-password') {
      throw redirect({ to: '/change-password' });
    }
  },
  component: AuthLayout,
});

function AuthLayout() {
  const user = useAuthStore((s) => s.user);
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [cmdOpen, setCmdOpen] = useState(false);
  const router = useRouter();
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  // Sessão perdida fora de navegação (refresh falhou → forceLogout): o guard
  // beforeLoad não re-executa sozinho, então leva o operador ao /login em vez
  // de deixar a página montada morrendo em 401.
  useEffect(
    () =>
      onSessionExpired(() => {
        const { pathname: from, searchStr } = router.state.location;
        void router.navigate({
          to: '/login',
          search: { redirect: from + searchStr },
          replace: true,
        });
      }),
    [router],
  );

  return (
    <ProviderScopeProvider>
      <AppShell
        collapsed={collapsed}
        mobileOpen={mobileOpen}
        onMobileClose={() => setMobileOpen(false)}
        sidebar={<Sidebar collapsed={collapsed} user={user} onNavigate={() => setMobileOpen(false)} />}
        footer={<Footer />}
        topbar={
          <Topbar
            collapsed={collapsed}
            onToggleCollapsed={() => setCollapsed((c) => !c)}
            onMobileOpen={() => setMobileOpen(true)}
            onCmdOpen={() => setCmdOpen(true)}
            onLogout={async () => {
              await logoutRemote();
              void router.navigate({ to: '/login' });
            }}
            user={user}
          />
        }
      >
        <Outlet />
      </AppShell>
      <CommandPalette open={cmdOpen} onOpenChange={setCmdOpen} />
    </ProviderScopeProvider>
  );
}
