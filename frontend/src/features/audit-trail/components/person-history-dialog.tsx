import { useEffect, useState } from 'react';
import { AlertCircle } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { readApiErrorBody } from '@/lib/api-error';
import { PERSON_HISTORY_PAGE_SIZE, usePersonHistory } from '../api';
import { TrailTable } from './trail-table';

const FORBIDDEN_CODE = 'audit_trail.forbidden';
const FORBIDDEN_TEXT = 'Você não pode ver o histórico desta pessoa.';
const FALLBACK_ERROR = 'Não foi possível carregar o histórico. Tente de novo.';
const EMPTY_TEXT = 'Nenhuma alteração registrada para esta pessoa.';

type Failure = { message: string; canRetry: boolean };

/**
 * 403 `audit_trail.forbidden` (pessoa fora do alcance ou inexistente): texto do servidor (C9);
 * qualquer outra falha, a mensagem genérica, sem repassar detalhe técnico.
 */
async function describeFailure(error: unknown): Promise<Failure> {
  const body = await readApiErrorBody(error);
  if (body?.code === FORBIDDEN_CODE) return { message: body.detail ?? FORBIDDEN_TEXT, canRetry: false };
  return { message: FALLBACK_ERROR, canRetry: true };
}

function HistoryError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const [failure, setFailure] = useState<Failure>();
  useEffect(() => {
    let cancelled = false;
    describeFailure(error).then((described) => {
      if (!cancelled) setFailure(described);
    });
    return () => {
      cancelled = true;
    };
  }, [error]);
  if (!failure) return null;
  return (
    <Alert variant="destructive">
      <AlertCircle />
      <AlertDescription>
        <p>{failure.message}</p>
        {failure.canRetry && (
          <Button type="button" variant="outline" size="sm" className="mt-2" onClick={onRetry}>Tentar de novo</Button>
        )}
      </AlertDescription>
    </Alert>
  );
}

type PagerProps = { page: number; total: number; onPage: (page: number) => void };

function HistoryPager({ page, total, onPage }: PagerProps) {
  const pages = Math.max(1, Math.ceil(total / PERSON_HISTORY_PAGE_SIZE));
  return (
    <nav aria-label="Páginas do histórico" className="flex items-center justify-end gap-3 text-sm">
      <span>{`Página ${page} de ${pages}`}</span>
      <Button type="button" variant="outline" size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>Anterior</Button>
      <Button type="button" variant="outline" size="sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>Próxima</Button>
    </nav>
  );
}

/** Montado só com o diálogo aberto e com `key` da pessoa: a página volta à 1 a cada pessoa. */
function HistoryBody({ personId }: { personId: string }) {
  const [page, setPage] = useState(1);
  const { data, isLoading, error, refetch } = usePersonHistory(personId, page);
  if (isLoading) return <Skeleton role="status" aria-label="Carregando histórico" className="h-40 w-full" />;
  if (error) return <HistoryError error={error} onRetry={() => void refetch()} />;
  if (!data) return null;
  if (data.total === 0) return <p className="py-6 text-center text-muted-foreground">{EMPTY_TEXT}</p>;
  return (
    <div className="space-y-3">
      <TrailTable entries={data.items} showSubject={false} />
      <HistoryPager page={page} total={data.total} onPage={setPage} />
    </div>
  );
}

type Props = {
  person: { id: string; name: string };
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/** Histórico de alterações de uma pessoa, dos mais recentes aos mais antigos (spec A5, D10). */
export function PersonHistoryDialog({ person, open, onOpenChange }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>{`Histórico de ${person.name}`}</DialogTitle>
          <DialogDescription>Quem alterou o quê, quando e por quê. Os mais recentes aparecem primeiro.</DialogDescription>
        </DialogHeader>
        <HistoryBody key={person.id} personId={person.id} />
      </DialogContent>
    </Dialog>
  );
}
