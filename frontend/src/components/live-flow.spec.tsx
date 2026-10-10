import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LiveFlow } from './live-flow';

describe('LiveFlow', () => {
  it('renders all five real counters, including visible failures', () => {
    render(<LiveFlow counts={{ queued: 12, sent: 23, delivered: 91, read: 72, failed: 4 }} />);

    expect(within(screen.getByTestId('flow-counter-queued')).getByText('12')).toBeInTheDocument();
    expect(within(screen.getByTestId('flow-counter-sent')).getByText('23')).toBeInTheDocument();
    expect(within(screen.getByTestId('flow-counter-delivered')).getByText('91')).toBeInTheDocument();
    expect(within(screen.getByTestId('flow-counter-read')).getByText('72')).toBeInTheDocument();
    expect(within(screen.getByTestId('flow-counter-failed')).getByText('4')).toBeInTheDocument();
    expect(screen.getByLabelText('Falhas: 4')).toBeInTheDocument();
  });
});
