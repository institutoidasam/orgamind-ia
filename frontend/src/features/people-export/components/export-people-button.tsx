import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { usePermission } from '@/features/permissions/use-permission';
import { ExportPeopleDialog } from './export-people-dialog';

/** Botão "Exportar" que abre o diálogo; some sem `pessoas.exportar` (quem decide é a API). */
export function ExportPeopleButton({ defaultSectorId }: { defaultSectorId?: string }) {
  const allowed = usePermission('pessoas.exportar');
  const [open, setOpen] = useState(false);
  if (!allowed) return null;
  return (
    <>
      <Button type="button" variant="outline" onClick={() => setOpen(true)}>
        Exportar
      </Button>
      <ExportPeopleDialog open={open} onOpenChange={setOpen} defaultSectorId={defaultSectorId} />
    </>
  );
}
