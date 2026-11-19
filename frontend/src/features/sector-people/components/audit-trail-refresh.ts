import { useQueryClient } from '@tanstack/react-query';

/**
 * Depois de escrever em uma pessoa (inativar, reativar, editar, mover, tirar), o Histórico e a
 * trilha geral precisam reler: `['audit-trail']` cobre as duas consultas.
 */
export function useRefreshAuditTrail() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ['audit-trail'] });
}
