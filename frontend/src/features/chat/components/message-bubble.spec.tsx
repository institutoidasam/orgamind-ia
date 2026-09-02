import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

vi.mock('./media-attachment', () => ({
  MediaAttachment: () => <div data-testid="media-attachment">media-sentinel</div>,
}));

import { MessageBubble } from './message-bubble';
import type { ChatMessage } from '../schemas';

const base: ChatMessage = {
  id: 'm1', conversationId: 'c1', direction: 'INBOUND', kind: 'TEXT', content: 'Olá', status: 'RECEIVED',
  providerMessageId: null, quotedWaMessageId: null, quotedPreview: null,
  createdAt: '2026-06-05T14:33:00.000Z', sentAt: null, deliveredAt: null, readAt: null, receivedAt: '2026-06-05T14:33:00.000Z', media: null,
  transcript: null,
};

const audioMedia: ChatMessage['media'] = {
  id: 'mm2', kind: 'AUDIO', status: 'READY', mimeType: 'audio/ogg', fileName: null,
  sizeBytes: 5000, durationSec: 12, width: null, height: null,
};

const imageMedia: ChatMessage['media'] = {
  id: 'mm1', kind: 'IMAGE', status: 'READY', mimeType: 'image/jpeg', fileName: 'x.jpg',
  sizeBytes: 1000, durationSec: null, width: 800, height: 600,
};

describe('MessageBubble', () => {
  it('renders inbound text', () => {
    render(<MessageBubble message={base} />);
    expect(screen.getByText('Olá')).toBeInTheDocument();
  });

  it('renders no content span when content is null', () => {
    const { container } = render(<MessageBubble message={{ ...base, kind: 'TEXT', content: null }} />);
    expect(container.querySelector('span')).toBeNull();
  });

  it('renders MediaAttachment for non-text inbound with media', () => {
    render(<MessageBubble message={{ ...base, kind: 'IMAGE', content: null, media: imageMedia }} />);
    expect(screen.getByTestId('media-attachment')).toBeInTheDocument();
  });

  it('does not crash on an unknown status (outbound)', () => {
    render(<MessageBubble message={{ ...base, direction: 'OUTBOUND', status: 'TOTALLY_NEW' }} />);
    expect(screen.getByText('Olá')).toBeInTheDocument();
  });

  it('renders quoted preview when present', () => {
    render(<MessageBubble message={{ ...base, quotedPreview: 'pergunta?' }} />);
    expect(screen.getByText(/pergunta\?/)).toBeInTheDocument();
  });

  // A1 — voice-note transcript
  it('renders transcript under audio when kind=AUDIO and transcript is set', () => {
    render(<MessageBubble message={{ ...base, kind: 'AUDIO', content: null, media: audioMedia, transcript: 'oi tudo bem?' }} />);
    const block = screen.getByTestId('voice-transcript');
    expect(block).toBeInTheDocument();
    expect(block).toHaveTextContent('oi tudo bem?');
  });

  it('does not render transcript block when transcript is null', () => {
    render(<MessageBubble message={{ ...base, kind: 'AUDIO', content: null, media: audioMedia, transcript: null }} />);
    expect(screen.queryByTestId('voice-transcript')).not.toBeInTheDocument();
  });

  it('does not render transcript block for non-audio kind even if transcript is set', () => {
    render(<MessageBubble message={{ ...base, kind: 'TEXT', content: 'hello', transcript: 'ignored' }} />);
    expect(screen.queryByTestId('voice-transcript')).not.toBeInTheDocument();
  });

  // A2 — status ticks for outbound messages
  it('renders SENT tick (single check) for outbound SENT messages', () => {
    render(<MessageBubble message={{ ...base, direction: 'OUTBOUND', status: 'SENT' }} />);
    // StatusTicks renders a span with title "Enviada"
    expect(screen.getByTitle('Enviada')).toBeInTheDocument();
  });

  it('renders DELIVERED tick (double check) for outbound DELIVERED messages', () => {
    render(<MessageBubble message={{ ...base, direction: 'OUTBOUND', status: 'DELIVERED' }} />);
    expect(screen.getByTitle('Entregue')).toBeInTheDocument();
  });

  it('renders READ tick (colored double check) for outbound READ messages', () => {
    render(<MessageBubble message={{ ...base, direction: 'OUTBOUND', status: 'READ' }} />);
    expect(screen.getByTitle('Lida')).toBeInTheDocument();
  });

  it('renders FAILED tick (warning) for outbound FAILED messages', () => {
    render(<MessageBubble message={{ ...base, direction: 'OUTBOUND', status: 'FAILED' }} />);
    expect(screen.getByTitle('Falhou')).toBeInTheDocument();
  });

  it('does not render status ticks for inbound messages', () => {
    render(<MessageBubble message={{ ...base, direction: 'INBOUND', status: 'RECEIVED' }} />);
    // No tick titles should appear for inbound
    expect(screen.queryByTitle('Enviada')).not.toBeInTheDocument();
    expect(screen.queryByTitle('Entregue')).not.toBeInTheDocument();
  });
});
