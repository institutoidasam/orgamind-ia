import { useCallback } from 'react';
import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router';
import { hasPermission } from '@/features/permissions/access';
import { ImportPage, type BatchChange } from '@/features/people-import/components/import-page';
import { useAuthStore } from '@/stores/auth.store';

const route = createFileRoute('/_authenticated/importar-pessoas/')({
  validateSearch: (search: Record<string, unknown>): { lote?: string } =>
    typeof search.lote === 'string' && search.lote !== '' ? { lote: search.lote } : {},
  beforeLoad: () => {
    const { user } = useAuthStore.getState();
    if (!hasPermission(user, 'pessoas.importar')) {
      throw redirect({ to: '/dashboard' });
    }
  },
  component: ImportPeoplePage,
});
export { route as Route };

/** O lote aberto fica na URL (`?lote=<id>`): recarregar a página volta ao passo certo (EX27). */
function ImportPeoplePage() {
  const { lote } = route.useSearch();
  const navigate = useNavigate();
  const changeBatch = useCallback<BatchChange>(
    (id, options) => {
      void navigate({ to: '/importar-pessoas', search: id ? { lote: id } : {}, replace: options?.replace ?? false });
    },
    [navigate],
  );
  return <ImportPage batchId={lote} onBatchChange={changeBatch} />;
}
