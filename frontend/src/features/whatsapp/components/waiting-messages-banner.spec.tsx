import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { WaitingMessagesBanner } from './waiting-messages-banner';

describe('WaitingMessagesBanner', () => {
  it('renderiza com contagem > 0', () => {
    render(<WaitingMessagesBanner waitingCount={42} instanceNames={['Suporte']} />);
    expect(screen.getByText(/42 mensagens aguardando/i)).toBeInTheDocument();
    expect(screen.getByText(/Suporte/)).toBeInTheDocument();
  });

  it('não renderiza nada quando contagem = 0', () => {
    const { container } = render(<WaitingMessagesBanner waitingCount={0} instanceNames={[]} />);
    expect(container.firstChild).toBeNull();
  });
});
