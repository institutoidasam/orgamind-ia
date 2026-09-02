import { toast } from 'sonner';
import { Bot as BotIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { usePauseBot, useResumeBot } from '../api';

type Props = { conversationId: string; botName: string | null; botPaused: boolean };

export function BotControl({ conversationId, botName, botPaused }: Props) {
  const pause = usePauseBot();
  const resume = useResumeBot();
  if (!botName) return null;

  const toggle = async () => {
    try {
      if (botPaused) {
        await resume.mutateAsync(conversationId);
        toast.success('Bot reativado nesta conversa.');
      } else {
        await pause.mutateAsync(conversationId);
        toast.success('Bot pausado — você assumiu a conversa.');
      }
    } catch {
      toast.error('Não foi possível alterar o estado do bot.');
    }
  };

  return (
    <div className="flex items-center gap-2">
      <Badge variant={botPaused ? 'secondary' : 'default'} className="gap-1">
        <BotIcon className="size-3" /> {botName} {botPaused ? '(pausado)' : '(ativo)'}
      </Badge>
      <Button size="sm" variant="outline" onClick={toggle} disabled={pause.isPending || resume.isPending}>
        {botPaused ? 'Reativar bot' : 'Pausar bot'}
      </Button>
    </div>
  );
}
