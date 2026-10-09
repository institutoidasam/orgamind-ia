import type { ReactElement } from 'react';
import type { ChatMessage } from '../schemas';
import { useChatMedia } from '../use-chat-media';

type Media = NonNullable<ChatMessage['media']>;
type MediaKind = 'IMAGE' | 'STICKER' | 'VIDEO' | 'AUDIO' | 'DOCUMENT';

const PENDING_LABEL: Record<string, string> = {
  IMAGE: '📷 Baixando imagem…', VIDEO: '🎬 Baixando vídeo…', AUDIO: '🎤 Baixando áudio…', DOCUMENT: '📎 Baixando documento…',
};

const renderImage = (url: string, media: Media): ReactElement =>
  <img src={url} alt={media.fileName ?? 'imagem'} className="max-h-64 rounded-md" />;

const renderDocument = (url: string, media: Media): ReactElement =>
  <a href={url} download={media.fileName ?? 'arquivo'} className="text-xs underline" style={{ color: 'var(--brand-blue)' }}>📎 {media.fileName ?? 'documento'}</a>;

const RENDERERS: Record<MediaKind, (url: string, media: Media) => ReactElement> = {
  IMAGE: renderImage,
  STICKER: renderImage,
  VIDEO: (url) => <video src={url} controls className="max-h-64 rounded-md" />,
  AUDIO: (url) => <audio src={url} controls className="w-56" />,
  DOCUMENT: renderDocument,
};

export function MediaAttachment({ message }: { message: ChatMessage }) {
  const media = message.media!;
  const ready = media.status === 'READY';
  const { data: url, isLoading } = useChatMedia(media.id, ready);

  if (media.status === 'FAILED') return <div className="text-xs" style={{ color: 'var(--st-failed-fg)' }}>Mídia indisponível</div>;
  if (!ready || isLoading || !url) return <div className="text-xs" style={{ color: 'var(--foreground-muted)' }}>{PENDING_LABEL[media.kind] ?? 'Baixando…'}</div>;

  const render = RENDERERS[media.kind as MediaKind] ?? renderDocument;
  return render(url, media);
}
