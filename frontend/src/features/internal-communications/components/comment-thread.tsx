import { useRef, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { useComment } from '../api';
import type { CommunicationDetail } from '../schemas';
import { dateTime, eventText, personName } from '../utils';

type CommentThreadProps = {
  communicationId: string;
  events: CommunicationDetail['events'];
  readonly: boolean;
};

function CommentHistory({ events }: Pick<CommentThreadProps, 'events'>) {
  return <div className="mt-6 border-t pt-5">
    <h2 className="font-heading text-lg">Histórico</h2>
    <div className="mt-3 space-y-4">
      {events.map((event) => <article key={event.id} className="border-l-2 border-[var(--brand-orange)] pl-3">
        <p className="text-sm"><strong>{personName(event.author)}</strong> {eventText(event.kind, event.message)}</p>
        <p className="text-xs text-muted-foreground">{dateTime(event.createdAt)}</p>
      </article>)}
    </div>
  </div>;
}

function CommentComposer({ communicationId }: Pick<CommentThreadProps, 'communicationId'>) {
  const [message, setMessage] = useState('');
  const posting = useRef(false);
  const comment = useComment(communicationId);
  const trimmed = message.trim();

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!trimmed || comment.isPending || posting.current) return;
    posting.current = true;
    comment.mutate(trimmed, {
      onError: () => { posting.current = false; },
      onSuccess: () => { setMessage(''); posting.current = false; },
    });
  }

  return <form className="mt-6 border-t pt-5" onSubmit={submit}>
    <label className="grid gap-2 text-sm font-medium" htmlFor="comment-message">
      Adicionar comentário
      <Textarea id="comment-message" value={message} maxLength={10000} disabled={comment.isPending}
        onChange={(event) => setMessage(event.target.value)} placeholder="Escreva uma atualização para os setores envolvidos." />
    </label>
    {comment.isError ? <p role="alert" className="mt-2 text-sm text-destructive">Não foi possível publicar o comentário. Tente novamente.</p> : null}
    <Button className="mt-3" type="submit" disabled={!trimmed || comment.isPending}>
      {comment.isPending ? 'Publicando comentário…' : 'Publicar comentário'}
    </Button>
  </form>;
}

export function CommentThread({ communicationId, events, readonly }: CommentThreadProps) {
  return <>
    {readonly ? null : <CommentComposer communicationId={communicationId} />}
    <CommentHistory events={events} />
  </>;
}
