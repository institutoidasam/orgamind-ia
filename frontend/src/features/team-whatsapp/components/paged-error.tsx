import { QueryErrorFallback } from '@/components/query-error-fallback';
import { Button } from '@/components/ui/button';

type Props = { error: unknown; onRetry: () => void; page: number; onFirstPage: () => void };

/**
 * Erro de uma lista paginada. Fora da página 1 a paginação some junto com os dados, então o erro
 * oferece voltar à primeira página, além de `Tentar novamente`.
 */
export function PagedError({ error, onRetry, page, onFirstPage }: Props) {
  return (
    <div className="space-y-2">
      <QueryErrorFallback error={error} onRetry={onRetry} />
      {page > 1 && <Button variant="outline" onClick={onFirstPage}>Voltar à primeira página</Button>}
    </div>
  );
}
