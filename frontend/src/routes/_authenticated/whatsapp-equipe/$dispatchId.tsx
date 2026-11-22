import { useEffect, useState } from 'react';
import { createFileRoute, Link } from '@tanstack/react-router';
import { QueryErrorFallback } from '@/components/query-error-fallback';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useTeamDispatch } from '@/features/team-whatsapp/api';
import { DispatchResult } from '@/features/team-whatsapp/components/dispatch-result';
import { apiErrorCode } from '@/features/team-whatsapp/error-messages';

const route = createFileRoute('/_authenticated/whatsapp-equipe/$dispatchId')({
  component: DispatchResultPage,
});
export { route as Route };

const NOT_FOUND_CODE = 'team_whatsapp.dispatch_not_found';
const NOT_FOUND_TEXT = 'Envio não encontrado.';

/** 404 `dispatch_not_found` (não existe ou não é seu) vira o aviso; qualquer outro erro, o `QueryErrorFallback`. */
function ResultError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const [notFound, setNotFound] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    void apiErrorCode(error).then((code) => {
      if (!cancelled) setNotFound(code === NOT_FOUND_CODE);
    });
    return () => { cancelled = true; };
  }, [error]);
  if (notFound === null) return null;
  if (notFound) return <p role="alert" className="rounded-md border p-6 text-sm">{NOT_FOUND_TEXT}</p>;
  return <QueryErrorFallback error={error} onRetry={onRetry} />;
}

function DispatchResultPage() {
  const { dispatchId } = route.useParams();
  const dispatch = useTeamDispatch(dispatchId);
  return (
    <main className="mx-auto max-w-5xl space-y-4">
      <Button asChild variant="outline">
        <Link to="/whatsapp-equipe">Voltar</Link>
      </Button>
      {dispatch.isLoading && <Skeleton className="h-64 w-full" />}
      {dispatch.isError && <ResultError error={dispatch.error} onRetry={dispatch.refetch} />}
      {dispatch.data && <DispatchResult dispatch={dispatch.data} />}
    </main>
  );
}
