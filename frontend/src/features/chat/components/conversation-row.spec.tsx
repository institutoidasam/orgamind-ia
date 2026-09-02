import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ConversationRow } from './conversation-row';
import { instanceColor } from '../instance-color';
import type { ConversationSummary } from '../schemas';

const base: ConversationSummary = {
  id: 'c1',
  instanceId: 'i1',
  instanceName: 'Número A',
  remoteJid: '5511999999999@s.whatsapp.net',
  phoneE164: '+5511999999999',
  contactId: null,
  displayName: 'Cliente',
  waName: null,
  profilePicUrl: null,
  lastMessageAt: null,
  lastMessagePreview: 'oi',
  lastMessageDirection: 'INBOUND',
  unreadCount: 0,
};

describe('ConversationRow instance badge', () => {
  it('shows the instance name when showInstanceBadge is true', () => {
    render(<ConversationRow c={base} active={false} showInstanceBadge onClick={vi.fn()} />);
    expect(screen.getByText('Número A')).toBeInTheDocument();
  });

  it('hides the instance name by default', () => {
    render(<ConversationRow c={base} active={false} onClick={vi.fn()} />);
    expect(screen.queryByText('Número A')).not.toBeInTheDocument();
  });

  it('badge shows a dot colored by the conversation instanceId', () => {
    const fixture: ConversationSummary = { ...base, instanceId: 'i1', instanceName: 'Atendimento' };
    render(<ConversationRow c={fixture} active={false} showInstanceBadge onClick={vi.fn()} />);
    expect(screen.getByTestId('conversation-instance-dot')).toHaveStyle({
      background: instanceColor('i1'),
    });
    expect(screen.getByText('Atendimento')).toBeInTheDocument();
  });
});

// A2 — avatar rendering
describe('ConversationRow avatar', () => {
  it('renders initials when profilePicUrl is null', () => {
    render(<ConversationRow c={{ ...base, profilePicUrl: null, displayName: 'Cliente' }} active={false} onClick={vi.fn()} />);
    // initials('Cliente') → 'CL' or 'C' depending on implementation
    const avatar = screen.getByRole('button').querySelector('span > *');
    expect(avatar).toBeTruthy();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('renders an <img> when profilePicUrl is set', () => {
    const { container } = render(<ConversationRow c={{ ...base, profilePicUrl: 'https://cdn.example.com/pic.jpg' }} active={false} onClick={vi.fn()} />);
    // alt="" makes the img decorative (role="presentation"); use querySelector
    const img = container.querySelector('img');
    expect(img).toBeInTheDocument();
    expect(img).toHaveAttribute('src', 'https://cdn.example.com/pic.jpg');
  });
});

// Track A — assignee badge
describe('ConversationRow assignee badge', () => {
  it('shows the assignee initials when the conversation is assigned', () => {
    render(<ConversationRow c={{ ...base, assignedUserId: 'u9', assignedUserName: 'Ana Lima' }} active={false} onClick={vi.fn()} />);
    expect(screen.getByTestId('assignee-badge')).toHaveTextContent('AL');
  });

  it('renders no assignee badge when unassigned', () => {
    render(<ConversationRow c={{ ...base, assignedUserId: null, assignedUserName: null }} active={false} onClick={vi.fn()} />);
    expect(screen.queryByTestId('assignee-badge')).not.toBeInTheDocument();
  });
});

// F4 — multi-provider channels inbox badge: only rendered when the caller
// says 2+ providers are present among the loaded conversations (computed by
// ConversationsList, not here — this component just obeys the prop).
describe('ConversationRow provider badge', () => {
  it('shows the provider badge when showProviderBadge is true and c.provider is set', () => {
    render(<ConversationRow c={{ ...base, provider: 'TWILIO' }} active={false} showProviderBadge onClick={vi.fn()} />);
    expect(screen.getByText('Twilio')).toBeInTheDocument();
  });

  it('hides the provider badge by default (showProviderBadge=false)', () => {
    render(<ConversationRow c={{ ...base, provider: 'TWILIO' }} active={false} onClick={vi.fn()} />);
    expect(screen.queryByText('Twilio')).not.toBeInTheDocument();
  });

  it('hides the provider badge when showProviderBadge is true but c.provider is missing', () => {
    render(<ConversationRow c={{ ...base, provider: undefined }} active={false} showProviderBadge onClick={vi.fn()} />);
    expect(screen.queryByText('Twilio')).not.toBeInTheDocument();
    expect(screen.queryByText('Evolution')).not.toBeInTheDocument();
  });
});
