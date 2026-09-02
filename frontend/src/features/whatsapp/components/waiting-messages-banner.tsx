import { AlertTriangle } from 'lucide-react';

type Props = {
  waitingCount: number;
  instanceNames: string[];
};

export function WaitingMessagesBanner({ waitingCount, instanceNames }: Props) {
  if (waitingCount === 0) return null;
  const inst = instanceNames.join(', ');
  return (
    <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
      <AlertTriangle className="size-4 shrink-0" />
      <div>
        <strong>{waitingCount} mensagens aguardando</strong> a instância "{inst}" voltar.
        Serão enviadas assim que reconectar.
      </div>
    </div>
  );
}
