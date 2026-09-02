import { toast } from 'sonner';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { extractApiError } from '@/lib/api-error';
import { useDifyApps, useAssignBot } from '@/features/bots/api';

const NONE = '__none__';

export function InstanceBotSelect({ instanceId, currentDifyAppId }: { instanceId: string; currentDifyAppId: string | null }) {
  const { data: apps, isLoading, isError } = useDifyApps();
  const assign = useAssignBot();

  const onChange = async (value: string) => {
    const difyAppId = value === NONE ? null : value;
    try {
      await assign.mutateAsync({ instanceId, difyAppId });
      toast.success(difyAppId ? 'Bot atribuído a este número.' : 'Bot removido deste número.');
    } catch (err) {
      const { title, message } = await extractApiError(err);
      toast.error(title, { description: message });
    }
  };

  return (
    <div className="space-y-1">
      <Label>Bot que responde neste número</Label>
      <Select value={currentDifyAppId ?? NONE} onValueChange={onChange} disabled={isLoading || assign.isPending}>
        <SelectTrigger><SelectValue placeholder="Nenhum (só humano)" /></SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>Nenhum (só humano)</SelectItem>
          {(apps ?? []).map((a) => (
            <SelectItem key={a.difyAppId} value={a.difyAppId}>{a.name}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">
        {isError ? 'Não foi possível listar apps do Dify agora.' : 'Lista vinda do Dify. O bot pausa quando você assume a conversa.'}
      </p>
    </div>
  );
}
