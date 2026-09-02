import { createFileRoute, Link } from '@tanstack/react-router';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useImports } from '@/features/imports/api';
import { QueryErrorFallback } from '@/components/query-error-fallback';

export const Route = createFileRoute('/_authenticated/imports/')({
  component: ImportsPage,
});

/**
 * PT-BR labels for each batch status. `statusLabel` always returns a string
 * (falls back to the raw value) so an unknown enum from the backend renders as
 * text instead of crashing the global ErrorBoundary into a full-page error.
 */
const STATUS_LABELS: Record<string, string> = {
  PENDING: 'Na fila',
  PROCESSING: 'Processando...',
  COMPLETED: 'Concluída',
  FAILED: 'Falhou',
};

function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

function ImportsPage() {
  const { data, isLoading, isError, error, refetch } = useImports();

  if (isError) {
    return <QueryErrorFallback error={error} onRetry={() => refetch()} />;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Importações</h1>
        <Button asChild>
          <Link to="/imports/new">Nova importação</Link>
        </Button>
      </div>
      {isLoading ? (
        <p>Carregando...</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Arquivo</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Total</TableHead>
              <TableHead>Importados</TableHead>
              <TableHead>Data</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data?.map((b) => (
              <TableRow key={b.id}>
                <TableCell>{b.filename}</TableCell>
                <TableCell>{statusLabel(b.status)}</TableCell>
                <TableCell>{b.totalRows}</TableCell>
                <TableCell>{b.importedRows}</TableCell>
                <TableCell>{new Date(b.createdAt).toLocaleString('pt-BR')}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
