import { Button } from '@/components/ui/button';

type PaginationProps = {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
};

export function Pagination({ page, pageSize, total, onPageChange }: PaginationProps) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const currentPage = Math.min(page, totalPages);

  return <div className="flex items-center justify-between gap-3 text-sm text-muted-foreground">
    <span>Página {currentPage} de {totalPages} · {total} no total</span>
    <div className="flex gap-2">
      <Button variant="outline" disabled={currentPage === 1} onClick={() => onPageChange(currentPage - 1)}>Anterior</Button>
      <Button variant="outline" disabled={currentPage === totalPages} onClick={() => onPageChange(currentPage + 1)}>Próxima</Button>
    </div>
  </div>;
}
