import { Button } from '@/components/ui/button';

export function ReadConfirmationStatus({ error, retry }: { error: unknown; retry: () => void }) {
  if (!error) return null;
  return <p role="alert" className="text-sm text-destructive">Não foi possível confirmar a leitura. <Button type="button" size="sm" variant="outline" onClick={retry}>Tentar novamente</Button></p>;
}
