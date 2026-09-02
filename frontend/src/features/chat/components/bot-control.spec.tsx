import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const pauseMutate = vi.fn();
const resumeMutate = vi.fn();
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../api', () => ({
  usePauseBot: () => ({ isPending: false, mutateAsync: pauseMutate }),
  useResumeBot: () => ({ isPending: false, mutateAsync: resumeMutate }),
}));

import { BotControl } from './bot-control';

describe('BotControl', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders nothing when the conversation has no bot', () => {
    const { container } = render(<BotControl conversationId="c1" botName={null} botPaused={false} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('active bot: shows status and a pause action', async () => {
    pauseMutate.mockResolvedValueOnce({});
    render(<BotControl conversationId="c1" botName="Atendente" botPaused={false} />);
    expect(screen.getByText(/Atendente/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /pausar bot/i }));
    await waitFor(() => expect(pauseMutate).toHaveBeenCalledWith('c1'));
  });

  it('paused bot: shows a resume action', async () => {
    resumeMutate.mockResolvedValueOnce({});
    render(<BotControl conversationId="c1" botName="Atendente" botPaused={true} />);
    fireEvent.click(screen.getByRole('button', { name: /reativar bot/i }));
    await waitFor(() => expect(resumeMutate).toHaveBeenCalledWith('c1'));
  });
});
