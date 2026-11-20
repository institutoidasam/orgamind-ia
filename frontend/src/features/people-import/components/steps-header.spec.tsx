import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StepsHeader } from './steps-header';

describe('StepsHeader', () => {
  it('destaca o passo atual', () => {
    render(<StepsHeader current={3} />);
    const items = screen.getAllByRole('listitem');
    expect(items.map((item) => item.textContent)).toEqual(['1. Arquivo', '2. Colunas', '3. Prévia', '4. Resultado']);
    expect(screen.getByRole('listitem', { current: 'step' })).toHaveTextContent('3. Prévia');
    expect(screen.getByText('3. Prévia')).toHaveAttribute('data-variant', 'default');
    expect(screen.getByText('1. Arquivo')).toHaveAttribute('data-variant', 'outline');
    expect(screen.getAllByRole('listitem', { current: false })).toHaveLength(3);
  });
});
