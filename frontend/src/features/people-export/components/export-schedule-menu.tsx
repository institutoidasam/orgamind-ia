import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { usePermission } from '@/features/permissions/use-permission';
import { useExportSchedule, type ExportFormat } from '../api';

type Props = { sectorId: string; from: string; to: string };

/** Menu "Exportar" da Escala: CSV ou XLSX do setor e do período da tela. O erro sai por toast (api.ts). */
export function ExportScheduleMenu({ sectorId, from, to }: Props) {
  const allowed = usePermission('pessoas.exportar');
  const exportSchedule = useExportSchedule();
  if (!allowed) return null;
  const run = (format: ExportFormat) => exportSchedule.mutate({ format, sectorId, from, to });
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" disabled={exportSchedule.isPending}>
          {exportSchedule.isPending ? 'Exportando…' : 'Exportar'}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => run('csv')}>CSV</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => run('xlsx')}>XLSX</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
