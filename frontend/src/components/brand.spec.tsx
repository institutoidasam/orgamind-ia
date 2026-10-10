import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Brand } from './brand';

describe('Brand', () => {
  it('expõe produto e workspace quando há espaço para a identidade completa', () => {
    render(<Brand />);

    expect(screen.getByText('OrgaMind')).toBeTruthy();
    expect(screen.getByText('GBR Componentes')).toBeTruthy();
  });

  it('mantém o símbolo decorativo no modo compacto', () => {
    render(<Brand compact />);

    expect(screen.getByText('OrgaMind', { selector: '.sr-only' })).toBeTruthy();
  });
});
