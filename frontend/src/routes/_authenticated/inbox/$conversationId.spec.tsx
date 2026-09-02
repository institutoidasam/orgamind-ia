import { render } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useEffect } from 'react';

// --- Router mock: useParams reads a mutable holder so a rerender can simulate
// navigating from conversation A to conversation B without a real router. ------
let currentParams = { conversationId: 'A' };
vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (opts: { component: React.ComponentType }) => ({
    ...opts,
    useParams: () => currentParams,
  }),
}));

// --- Stub MessageThread: records every mount so the test can prove the subtree
// is remounted (fresh local state) when the conversation id changes. -----------
const mounts: string[] = [];
vi.mock('@/features/chat/components/message-thread', () => ({
  MessageThread: ({ conversationId }: { conversationId: string }) => {
    useEffect(() => {
      mounts.push(conversationId);
    }, []); // empty deps → fires once per mounted instance
    return <div data-testid="thread">{conversationId}</div>;
  },
}));

import { Route } from './$conversationId';

const ConversationView = (
  Route as unknown as { component: React.ComponentType }
).component;

beforeEach(() => {
  mounts.length = 0;
  currentParams = { conversationId: 'A' };
});

describe('ConversationView — per-conversation subtree isolation', () => {
  it('remounts MessageThread when the conversation id changes (no draft/reply leak)', () => {
    const { rerender } = render(<ConversationView />);
    expect(mounts).toEqual(['A']);

    // Operator clicks a different conversation in the list.
    currentParams = { conversationId: 'B' };
    rerender(<ConversationView />);

    // A fresh instance must mount for B; reusing the same instance would carry
    // over A's composer draft + quoted-reply target.
    expect(mounts).toEqual(['A', 'B']);
  });
});
