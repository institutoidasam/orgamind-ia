import type { ChatMessage } from '../schemas';
import { StatusTicks } from './chat-status';
import { MediaAttachment } from './media-attachment';

function timeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

export function MessageBubble({ message, onReply }: { message: ChatMessage; onReply?: (m: ChatMessage) => void }) {
  const out = message.direction === 'OUTBOUND';
  const hasTranscript = message.kind === 'AUDIO' && message.transcript;

  return (
    <div className={`flex ${out ? 'justify-end' : 'justify-start'}`}>
      <div
        className="max-w-[62%] rounded-lg px-3 py-1.5 text-sm"
        style={{
          background: out ? 'var(--st-read-bg, #ece5fd)' : 'var(--surface)',
          border: out ? 'none' : '1px solid var(--border)',
        }}
      >
        {message.quotedPreview ? (
          <div
            className="mb-1 rounded px-2 py-1 text-xs"
            style={{ borderLeft: '3px solid var(--brand-purple)', background: 'var(--surface-sunken)', color: 'var(--foreground-muted)' }}
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
        <div className="mt-0.5 flex items-center justify-end gap-1 text-[10px]" style={{ color: 'var(--foreground-muted)' }}>
          {timeLabel(message.createdAt)}
          {out ? <StatusTicks status={message.status} /> : null}
        </div>
      </div>
    </div>
  );
}
