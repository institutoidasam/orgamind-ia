import { useState } from 'react';
import { createFileRoute, redirect } from '@tanstack/react-router';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { QueryErrorFallback } from '@/components/query-error-fallback';
import { useAuthStore } from '@/stores/auth.store';
import { useLevels } from '@/features/levels/api';
import { LevelFormDialog } from '@/features/levels/components/level-form-dialog';
import { LevelsTable } from '@/features/levels/components/levels-table';
import type { LevelAdmin } from '@/features/levels/schemas';

const route = createFileRoute('/_authenticated/niveis/')({
  beforeLoad: () => {
    const { user } = useAuthStore.getState();
    if (user?.role !== 'ADMIN') {
      throw redirect({ to: '/dashboard' });
    }
  },
  component: LevelsPage,
});
export { route as Route };

/** `null` = fechado; `{}` = nível novo; `{ level }` = edição. */
type Editor = { level?: LevelAdmin } | null;

function LevelsPage() {
  const levels = useLevels();
  const [editor, setEditor] = useState<Editor>(null);
  if (levels.isError) return <QueryErrorFallback error={levels.error} onRetry={levels.refetch} />;
  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Níveis</h1>
          <p className="text-sm text-muted-foreground">
            Hierarquia das pessoas (como Coordenador ou Líder), usada no cadastro e no envio do WhatsApp da equipe.
          </p>
        </div>
        <Button onClick={() => setEditor({})}>
          <Plus className="mr-2 size-4" />
          Novo nível
        </Button>
      </header>
      <LevelsTable loading={levels.isLoading} items={levels.data ?? []} onEdit={(level) => setEditor({ level })} />
      <LevelFormDialog open={editor !== null} level={editor?.level} onOpenChange={(open) => !open && setEditor(null)} />
    </div>
  );
}
