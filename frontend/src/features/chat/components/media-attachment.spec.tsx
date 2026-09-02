import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// useChatMedia is mutated per test so we can exercise the loading / no-url guards.
let mediaHook: { data: string | undefined; isLoading: boolean } = { data: 'blob:fake', isLoading: false };
vi.mock('../use-chat-media', () => ({ useChatMedia: () => mediaHook }));
import { MediaAttachment } from './media-attachment';
import type { ChatMessage } from '../schemas';

const base = (over: Partial<NonNullable<ChatMessage['media']>>): ChatMessage => ({
  id: 'm', conversationId: 'c', direction: 'INBOUND', kind: 'IMAGE', content: null, status: 'RECEIVED',
  providerMessageId: 'p', quotedWaMessageId: null, quotedPreview: null, createdAt: '2026-06-05T00:00:00Z',
  sentAt: null, deliveredAt: null, readAt: null, receivedAt: '2026-06-05T00:00:00Z',
  media: { id: 'mm', kind: 'IMAGE', status: 'READY', mimeType: 'image/jpeg', fileName: 'x.jpg', sizeBytes: 1, durationSec: null, width: null, height: null, ...over },
});

describe('MediaAttachment', () => {
  beforeEach(() => {
    mediaHook = { data: 'blob:fake', isLoading: false };
  });

  it('renders an img for READY image', () => {
    render(<MediaAttachment message={base({})} />);
    expect(screen.getByAltText('x.jpg')).toHaveAttribute('src', 'blob:fake');
  });

  it('renders an img for READY sticker (shares the image renderer)', () => {
    render(<MediaAttachment message={base({ kind: 'STICKER', fileName: 's.webp' })} />);
    expect(screen.getByAltText('s.webp')).toHaveAttribute('src', 'blob:fake');
  });

  it('falls back to "imagem" alt when image has no fileName', () => {
    render(<MediaAttachment message={base({ fileName: null })} />);
    expect(screen.getByAltText('imagem')).toHaveAttribute('src', 'blob:fake');
  });

  it('renders a video element for READY video', () => {
    const { container } = render(<MediaAttachment message={base({ kind: 'VIDEO', fileName: 'v.mp4' })} />);
    const video = container.querySelector('video');
    expect(video).toHaveAttribute('src', 'blob:fake');
  });

  it('renders an audio element for READY audio', () => {
    const { container } = render(<MediaAttachment message={base({ kind: 'AUDIO', fileName: 'a.ogg' })} />);
    const audio = container.querySelector('audio');
    expect(audio).toHaveAttribute('src', 'blob:fake');
  });

  it('renders a download link for READY document (uses fileName)', () => {
    render(<MediaAttachment message={base({ kind: 'DOCUMENT', fileName: 'doc.pdf' })} />);
    const link = screen.getByRole('link', { name: /doc\.pdf/ });
    expect(link).toHaveAttribute('href', 'blob:fake');
    expect(link).toHaveAttribute('download', 'doc.pdf');
  });

  it('falls back to "documento"/"arquivo" when document has no fileName', () => {
    render(<MediaAttachment message={base({ kind: 'DOCUMENT', fileName: null })} />);
    const link = screen.getByRole('link', { name: /documento/ });
    expect(link).toHaveAttribute('download', 'arquivo');
  });

  it('renders a download link for an unknown kind (default renderer)', () => {
    render(<MediaAttachment message={base({ kind: 'CONTACT', fileName: 'vcard.vcf' })} />);
    expect(screen.getByRole('link', { name: /vcard\.vcf/ })).toHaveAttribute('href', 'blob:fake');
  });

  it('shows unavailable for FAILED media (guard 1)', () => {
    render(<MediaAttachment message={base({ status: 'FAILED' })} />);
    expect(screen.getByText(/indispon/i)).toBeInTheDocument();
  });

  it('shows the kind-specific pending label when not READY (guard 2)', () => {
    render(<MediaAttachment message={base({ status: 'PENDING', kind: 'IMAGE' })} />);
    expect(screen.getByText(/Baixando imagem/)).toBeInTheDocument();
  });

  it('shows the generic pending label for an unknown kind when not READY (guard 2)', () => {
    render(<MediaAttachment message={base({ status: 'PENDING', kind: 'CONTACT' })} />);
    expect(screen.getByText(/^Baixando…$/)).toBeInTheDocument();
  });

  it('shows pending while READY but the url is still loading (guard 2)', () => {
    mediaHook = { data: undefined, isLoading: true };
    render(<MediaAttachment message={base({ kind: 'VIDEO' })} />);
    expect(screen.getByText(/Baixando vídeo/)).toBeInTheDocument();
  });

  it('shows pending while READY but no url resolved yet (guard 2)', () => {
    mediaHook = { data: undefined, isLoading: false };
    render(<MediaAttachment message={base({ kind: 'AUDIO' })} />);
    expect(screen.getByText(/Baixando áudio/)).toBeInTheDocument();
  });
});
