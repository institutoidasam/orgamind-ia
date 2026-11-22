import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { QueryErrorFallback } from '@/components/query-error-fallback';
import { useSectors } from '@/features/internal-admin/api';

/**
 * D15: aviso uma vez só, no topo de Conexões, das áreas ativas que ainda não têm
 * número (GoZap e Evolution). Sem nenhuma, não mostra nada.
 */
export function SectorsWithoutNumberNotice() {
  const sectors = useSectors(true);
  if (sectors.isError) {
    return <QueryErrorFallback error={sectors.error} onRetry={() => sectors.refetch()} />;
  }
  const names = (sectors.data?.items ?? []).filter((s) => s.channel === null).map((s) => s.name);
  if (names.length === 0) return null;
  return (
    <Alert variant="destructive">
      <AlertTitle>{`Áreas sem número: ${names.join(', ')}`}</AlertTitle>
      <AlertDescription>
        O envio de mensagens da equipe fica bloqueado para essas áreas até cada uma ser ligada a um número.
      </AlertDescription>
    </Alert>
  );
}
