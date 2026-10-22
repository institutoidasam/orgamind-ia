import { Button } from '@/components/ui/button';

export function EmptySector({ onAddPeople }: { onAddPeople: () => void }) {
  return (
    <div className="space-y-3 rounded-lg border p-6">
      <p className="text-sm text-muted-foreground">Ninguém neste setor ainda.</p>
      <Button onClick={onAddPeople}>Adicionar pessoas</Button>
    </div>
  );
}
