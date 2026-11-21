import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SituationBadge } from './situation-badge';

describe('SituationBadge', () => {
  it('badge Pendente, Em atendimento, Resolvida', () => {
    const { rerender } = render(<SituationBadge situation="PENDING" />);
    expect(screen.getByTestId('situation-badge')).toHaveTextContent('Pendente');
    rerender(<SituationBadge situation="IN_PROGRESS" />);
    expect(screen.getByTestId('situation-badge')).toHaveTextContent('Em atendimento');
    rerender(<SituationBadge situation="RESOLVED" />);
    expect(screen.getByTestId('situation-badge')).toHaveTextContent('Resolvida');
  });
});
