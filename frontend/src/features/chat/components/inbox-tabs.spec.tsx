import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { InboxTabs } from './inbox-tabs';
import { instanceColor } from '../instance-color';

const insts = [
  { id: 'a', name: 'Número A' },
  { id: 'b', name: 'Número B' },
];

describe('InboxTabs', () => {
  it('renders nothing when fewer than 2 instances', () => {
    const { container } = render(
      <InboxTabs instances={[insts[0]]} value={null} onChange={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders "Todos" + one tab per instance when 2+', () => {
    render(<InboxTabs instances={insts} value={null} onChange={vi.fn()} />);
    expect(screen.getByText('Todos')).toBeInTheDocument();
    expect(screen.getByText('Número A')).toBeInTheDocument();
    expect(screen.getByText('Número B')).toBeInTheDocument();
  });

  it('calls onChange with the instance id when a tab is clicked, null for Todos', () => {
    const onChange = vi.fn();
    render(<InboxTabs instances={insts} value={null} onChange={onChange} />);
    fireEvent.click(screen.getByText('Número B'));
    expect(onChange).toHaveBeenCalledWith('b');
    fireEvent.click(screen.getByText('Todos'));
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('renders the NÚMERO group label when tabs are visible', () => {
    render(
      <InboxTabs
        instances={[{ id: 'i1', name: 'Atendimento' }, { id: 'i2', name: 'Vendas' }]}
        value={null}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByText('número')).toBeInTheDocument(); // uppercase via CSS
  });

  it('shows a colored dot per instance tab, keyed by instance id, and none on Todos', () => {
    render(
      <InboxTabs
        instances={[{ id: 'i1', name: 'Atendimento' }, { id: 'i2', name: 'Vendas' }]}
        value={null}
        onChange={vi.fn()}
      />,
    );
    const dot1 = screen.getByTestId('instance-dot-i1');
    expect(dot1).toHaveStyle({ background: instanceColor('i1') });
    expect(screen.getByTestId('instance-dot-i2')).toHaveStyle({ background: instanceColor('i2') });
    expect(screen.getByRole('button', { name: 'Todos' }).querySelector('[data-testid^="instance-dot"]')).toBeNull();
  });
});
