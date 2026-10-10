import { Outlet, useRouter, useRouterState } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { onSessionExpired, useAuthStore } from '@/stores/auth.store';
import { logoutRemote } from '@/lib/api-client';
import { AppShell } from '@/components/layout/app-shell';
import { Sidebar } from '@/components/layout/sidebar';
import { Topbar } from '@/components/layout/topbar';
import { Footer } from '@/components/layout/footer';
import { CommandPalette } from '@/components/command-palette';
import { ProviderScopeProvider } from '@/features/whatsapp/provider-scope';
import { canUseLegacyModules, type NavRole } from '@/lib/nav';

export function AuthenticatedLayout() {
  const user = useAuthStore((state) => state.user);
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpenForPath, setMobileOpenForPath] = useState<string | null>(null);
  const [cmdOpen, setCmdOpen] = useState(false);
  const router = useRouter();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const mobileOpen = mobileOpenForPath === pathname;

  useSessionRedirect(router);

  const shell = (
    <AuthenticatedShell
      collapsed={collapsed}
      cmdOpen={cmdOpen}
      mobileOpen={mobileOpen}
      onCmdOpen={() => setCmdOpen(true)}
      onLogout={async () => {
        await logoutRemote();
        void router.navigate({ to: '/login' });
      }}
      onMobileClose={() => setMobileOpenForPath(null)}
      onMobileOpen={() => setMobileOpenForPath(pathname)}
      onToggleCollapsed={() => setCollapsed((value) => !value)}
      setCmdOpen={setCmdOpen}
      user={user}
    />
  );

  return canUseLegacyModules(user?.role as NavRole | undefined)
    ? <ProviderScopeProvider>{shell}</ProviderScopeProvider>
    : shell;
}

function useSessionRedirect(router: ReturnType<typeof useRouter>) {
  useEffect(
    () => onSessionExpired(() => {
      const { pathname, searchStr } = router.state.location;
      void router.navigate({ to: '/login', search: { redirect: pathname + searchStr }, replace: true });
    }),
    [router],
  );
}

type ShellProps = {
  collapsed: boolean;
  cmdOpen: boolean;
  mobileOpen: boolean;
  onCmdOpen: () => void;
  onLogout: () => Promise<void>;
  onMobileClose: () => void;
  onMobileOpen: () => void;
  onToggleCollapsed: () => void;
  setCmdOpen: (open: boolean) => void;
  user: ReturnType<typeof useAuthStore.getState>['user'];
};

function AuthenticatedShell({ collapsed, cmdOpen, mobileOpen, onCmdOpen, onLogout, onMobileClose, onMobileOpen, onToggleCollapsed, setCmdOpen, user }: ShellProps) {
  return (
    <>
      <AppShell collapsed={collapsed} mobileOpen={mobileOpen} onMobileClose={onMobileClose}
        sidebar={<Sidebar collapsed={collapsed} user={user} onNavigate={onMobileClose} />}
        footer={<Footer />}
        topbar={<Topbar collapsed={collapsed} onToggleCollapsed={onToggleCollapsed} onMobileOpen={onMobileOpen} onCmdOpen={onCmdOpen} onLogout={onLogout} user={user} />}
      >
        <Outlet />
      </AppShell>
      <CommandPalette open={cmdOpen} onOpenChange={setCmdOpen} />
    </>
  );
}
