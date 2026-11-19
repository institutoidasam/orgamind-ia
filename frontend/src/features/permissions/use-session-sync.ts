import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchMe } from '@/features/auth/api';
import { onPermissionDenied } from '@/lib/api-client';
import { useAuthStore } from '@/stores/auth.store';

export const ME_QUERY_KEY = ['auth', 'me'] as const;

const REREAD_INTERVAL_MS = 5 * 60_000;

/**
 * Mantém as permissões da sessão em dia (DB14): relê `/auth/me` ao montar o
 * layout autenticado, ao voltar o foco à janela, a cada 5 minutos e depois de
 * um 403 `auth.permission_denied`. A matriz salva pelo ADMIN invalida
 * `ME_QUERY_KEY`. O front só esconde: a API decide em cada requisição.
 */
export function useSessionSync(): void {
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: ME_QUERY_KEY,
    queryFn: fetchMe,
    refetchOnMount: 'always',
    refetchOnWindowFocus: 'always',
    refetchInterval: REREAD_INTERVAL_MS,
  });

  useEffect(() => {
    if (!data) return;
    // Resposta atrasada de outra conta, ou depois do logout, não vira sessão.
    const { user, setUser } = useAuthStore.getState();
    if (user?.id === data.user.id) setUser(data.user);
  }, [data]);

  useEffect(
    () => onPermissionDenied(() => void queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY })),
    [queryClient],
  );
}
