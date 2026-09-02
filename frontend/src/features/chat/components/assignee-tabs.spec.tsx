import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AssigneeTabs } from './assignee-tabs';

describe('AssigneeTabs', () => {
  it('renders Todas / Minhas / Não atribuídas', () => {
    render(<AssigneeTabs value={null} onChange={vi.fn()} />);
    expect(screen.getByText('Todas')).toBeInTheDocument();
    expect(screen.getByText('Minhas')).toBeInTheDocument();
    expect(screen.getByText('Não atribuídas')).toBeInTheDocument();
  });

  it('calls onChange with "me" for Minhas, "unassigned" for Não atribuídas, null for Todas', () => {
    const onChange = vi.fn();
    render(<AssigneeTabs value={null} onChange={onChange} />);
    fireEvent.click(screen.getByText('Minhas'));
    expect(onChange).toHaveBeenCalledWith('me');
    fireEvent.click(screen.getByText('Não atribuídas'));
    expect(onChange).toHaveBeenCalledWith('unassigned');
    fireEvent.click(screen.getByText('Todas'));
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('renders the ATRIBUIÇÃO group label', () => {
    render(<AssigneeTabs value={null} onChange={vi.fn()} />);
    expect(screen.getByText('atribuição')).toBeInTheDocument(); // uppercase via CSS
  });
});
