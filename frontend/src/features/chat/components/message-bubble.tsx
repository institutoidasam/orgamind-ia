import type { ChatMessage } from '../schemas';
import { StatusTicks } from './chat-status';
import { MediaAttachment } from './media-attachment';

function timeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

function styleForDirection(outbound: boolean) {
  if (outbound) {
    return {
      bubble: {
        background: 'var(--brand-primary)',
        color: 'var(--surface)',
        border: '1px solid var(--brand-primary)',
      },
      metadataColor: 'var(--surface-sunken)',
    };
  }

  return {
    bubble: {
      background: 'var(--surface)',
      color: 'var(--foreground)',
      border: '1px solid var(--border)',
    },
    metadataColor: 'var(--foreground-muted)',
  };
}

export function MessageBubble({ message, onReply }: { message: ChatMessage; onReply?: (m: ChatMessage) => void }) {
  const out = message.direction === 'OUTBOUND';
  const hasTranscript = message.kind === 'AUDIO' && message.transcript;
  const style = styleForDirection(out);

  return (
    <div className={`flex ${out ? 'justify-end' : 'justify-start'}`}>
      <div
        className="max-w-[85%] rounded-lg px-3 py-2 text-sm sm:max-w-[62%]"
        style={style.bubble}
      >
        {message.quotedPreview ? (
          <div
            className="mb-1 rounded px-2 py-1 text-xs"
            style={{ borderLeft: '3px solid var(--brand-orange)', background: 'var(--surface-sunken)', color: 'var(--foreground-muted)' }}
          >
            ↩︎ {message.quotedPreview}
          </div>
        ) : null}
        {message.kind !== 'TEXT' && message.media ? <div className="mb-1"><MediaAttachment message={message} /></div> : null}
        {hasTranscript ? (
          <div
            data-testid="voice-transcript"
            className="mt-1 text-xs italic"
            style={{ color: 'var(--foreground-muted)' }}
          >
            transcrição: {message.transcript}
          </div>
        ) : null}
        {message.content ? <span>{message.content}</span> : null}
        {onReply ? (
          <button type="button" onClick={() => onReply(message)} className="ml-2 align-middle text-[10px] underline opacity-60 hover:opacity-100" style={{ color: 'var(--foreground-muted)' }}>
            responder
          </button>
        ) : null}
        <div className="mt-0.5 flex items-center justify-end gap-1 text-[10px]" style={{ color: style.metadataColor }}>
          {timeLabel(message.createdAt)}
          {out ? <StatusTicks status={message.status} /> : null}
        </div>
      </div>
    </div>
  );
}
