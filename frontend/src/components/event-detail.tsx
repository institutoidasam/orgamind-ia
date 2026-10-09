import { RotateCw, SendHorizontal } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { MessageStatusBadge } from '@/features/campaigns/components/message-status-badge';
import { SwimLanes } from '@/components/swim-lanes';
import {
  useRedispatchMessage,
  useRetryMessage,
} from '@/features/campaigns/api';
import type { CampaignMessage } from '@/features/campaigns/schemas';
import { initials } from '@/lib/initials';

type Props = {
  campaignId: string;
  message: CampaignMessage | null;
};

type Contact = CampaignMessage['contact'];

/**
 * Wraps a mutation in a toast-on-resolve handler. Keeps the JSX handlers named
 * and identical in behaviour (success/error toast around `mutateAsync(id)`).
 */
function useActionToast(
  mutateAsync: (id: string) => Promise<unknown>,
  messages: { success: string; error: string },
) {
  return async (id: string) => {
    try {
      await mutateAsync(id);
      toast.success(messages.success);
    } catch {
      toast.error(messages.error);
    }
  };
}

function ContactAvatar({ contact }: { contact: Contact }) {
  if (contact.profilePictureUrl) {
    return (
      <img
        src={contact.profilePictureUrl}
        alt=""
        className="size-11 shrink-0 rounded-full object-cover"
        referrerPolicy="no-referrer"
      />
    );
  }
  const ini = initials(contact.name);
  return (
    <span
      className="grid size-11 shrink-0 place-items-center rounded-full text-base font-semibold text-white"
      style={{ background: 'var(--brand-navy)' }}
    >
      {ini === '?' ? contact.phoneE164.slice(-2) : ini}
    </span>
  );
}

function RenderedVariables({
  variables,
}: {
  variables: CampaignMessage['variables'];
}) {
  const entries = Object.entries(variables ?? {});
  return (
    <pre
      className="whitespace-pre-wrap rounded-md p-3 text-sm"
      style={{ background: 'var(--surface-sunken)' }}
    >
      {entries.length === 0
        ? '(sem variáveis renderizadas)'
        : entries.map(([k, v]) => `{{${k}}} → ${v}`).join('\n')}
    </pre>
  );
}

export function EventDetail({ campaignId, message }: Props) {
  const retry = useRetryMessage(campaignId);
  const redispatch = useRedispatchMessage(campaignId);
  const [showBody, setShowBody] = useState(false);

  const onRetry = useActionToast(retry.mutateAsync, {
    success: 'Mensagem reenfileirada',
    error: 'Falha ao reenviar',
  });
  const onRedispatch = useActionToast(redispatch.mutateAsync, {
    success: 'Disparada nova mensagem',
    error: 'Falha ao disparar',
  });

  if (!message) {
    return (
      <div
        className="grid h-full place-items-center text-sm"
        style={{ color: 'var(--foreground-muted)' }}
      >
        Selecione um destinatário à esquerda.
      </div>
    );
  }

  const isFailed = message.status === 'FAILED';

  return (
    <div className="space-y-5 p-4">
      <header className="flex items-start gap-3">
        <ContactAvatar contact={message.contact} />
        <div className="min-w-0 flex-1">
          <h3 className="ds-display !text-2xl">{message.contact.name ?? '(sem nome)'}</h3>
          <div
            className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs"
            style={{ color: 'var(--foreground-muted)' }}
          >
            <span className="ds-mono">{message.contact.phoneE164}</span>
            {message.contact.city && (
              <>
                <span aria-hidden>·</span>
                <span>{message.contact.city}</span>
              </>
            )}
            {message.contact.tags.slice(0, 3).map((t) => (
              <span
                key={t}
                className="rounded-full px-1.5 py-0.5 text-[10px]"
                style={{
                  background: 'var(--brand-blue-soft)',
                  color: 'var(--brand-blue)',
                }}
              >
                {t}
              </span>
            ))}
          </div>
        </div>
        <MessageStatusBadge status={message.status} />
      </header>

      <SwimLanes message={message} />

      <footer className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => setShowBody((v) => !v)}>
          {showBody ? 'Esconder mensagem' : 'Ver mensagem'}
        </Button>
        {isFailed && (
          <Button
            variant="outline"
            size="sm"
            disabled={retry.isPending}
            onClick={() => onRetry(message.id)}
          >
            <RotateCw className="size-3.5" />
            Reenviar
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          disabled={redispatch.isPending}
          onClick={() => onRedispatch(message.id)}
        >
          <SendHorizontal className="size-3.5" />
          Disparar novamente
        </Button>
        <span className="ds-mono ml-auto text-xs" style={{ color: 'var(--foreground-muted)' }}>
          {message.id}
        </span>
      </footer>

      {showBody && <RenderedVariables variables={message.variables} />}
    </div>
  );
}
