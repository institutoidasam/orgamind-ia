import { useId } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export function SearchField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  const id = useId();
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} type="search" value={value} onChange={(event) => onChange(event.target.value)} />
    </div>
  );
}

/** Estado da busca quando não há lista para mostrar; null = mostrar os resultados. */
export function SearchFallback({ isError, isPending, count, emptyText }: { isError: boolean; isPending: boolean; count: number; emptyText: string }) {
  if (isError) return <p role="alert" className="text-sm text-destructive">Não foi possível buscar. Tente de novo.</p>;
  if (isPending) return <p className="text-sm text-muted-foreground">Buscando...</p>;
  if (count === 0) return <p className="text-sm text-muted-foreground">{emptyText}</p>;
  return null;
}
