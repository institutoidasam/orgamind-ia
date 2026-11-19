import { useQueryClient } from '@tanstack/react-query';

/**
 * O Histórico e a Trilha ficam em cache por 30 s (staleTime global): depois de mudar uma pessoa,
 * marca as consultas como velhas para o Histórico não mostrar dado antigo.
 */
export function useInvalidateAuditTrail() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: ['audit-trail'] });
  };
}
