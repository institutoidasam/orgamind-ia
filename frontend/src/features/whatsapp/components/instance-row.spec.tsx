import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Instance } from '../schemas';

vi.mock('./quota-panel', () => ({
  QuotaPanel: () => <div data-testid="quota-panel" />,
}));

import { InstanceRow } from './instance-row';

const instance: Instance = {
  id: 'instance-1',
  name: 'Canal principal',
  evolutionInstanceName: 'canal-principal',
  phoneE164: null,
  profileName: null,
  profilePictureUrl: null,
  ownerUserId: null,
  isDefault: false,
  isActive: true,
  dailySendLimit: 500,
  sentToday: 0,
  createdAt: '2026-10-08T00:00:00.000Z',
  lastConnectionState: 'close',
};

describe('InstanceRow', () => {
  it('uses the navy channel action surface with white text for a disconnected admin', () => {
    render(
      <InstanceRow
        instance={instance}
        isExpanded
        isOnline={false}
        isAdmin
        onToggle={vi.fn()}
        onConnect={vi.fn()}
        onSetDefault={vi.fn()}
        onRestart={vi.fn()}
        onRemove={vi.fn()}
        onOpenConfig={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: /conectar \(qr\)/i })).toHaveClass(
      'bg-[var(--brand-navy)]',
      'text-white',
    );
  });
});
