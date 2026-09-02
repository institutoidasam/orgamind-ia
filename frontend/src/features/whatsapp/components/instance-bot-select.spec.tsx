import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// jsdom lacks the APIs the Radix Select primitive relies on.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = globalThis.ResizeObserver ?? (ResizeObserverStub as never);
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

const assignMutate = vi.fn();
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/features/bots/api', () => ({
  useDifyApps: () => ({
    data: [{ difyAppId: 'app-1', name: 'Atendente', mode: 'chat' }],
    isLoading: false,
    isError: false,
  }),
  useAssignBot: () => ({ isPending: false, mutateAsync: assignMutate }),
}));

import { InstanceBotSelect } from './instance-bot-select';

describe('InstanceBotSelect', () => {
  beforeEach(() => vi.clearAllMocks());

  it('assigns the bot via difyAppId when a Dify app is chosen', async () => {
    assignMutate.mockResolvedValueOnce({});
    render(<InstanceBotSelect instanceId="i1" currentDifyAppId={null} />);
    // shadcn Select renders a combobox; open it then pick the bot option.
    fireEvent.click(screen.getByRole('combobox'));
    fireEvent.click(await screen.findByRole('option', { name: 'Atendente' }));
    await waitFor(() => expect(assignMutate).toHaveBeenCalledWith({ instanceId: 'i1', difyAppId: 'app-1' }));
  });

  it('unassigns when Nenhum is chosen', async () => {
    assignMutate.mockResolvedValueOnce({});
    render(<InstanceBotSelect instanceId="i1" currentDifyAppId="app-1" />);
    fireEvent.click(screen.getByRole('combobox'));
    fireEvent.click(await screen.findByRole('option', { name: /Nenhum/ }));
    await waitFor(() => expect(assignMutate).toHaveBeenCalledWith({ instanceId: 'i1', difyAppId: null }));
  });
});
