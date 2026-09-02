import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { AudienceExclusionsLine } from './audience-exclusions-line';

describe('AudienceExclusionsLine', () => {
  it('mostra o público e cada exclusão, na ordem em que se aplicam', () => {
    render(
      <AudienceExclusionsLine
        total={13400}
        items={[
          { label: 'já estão em campanha com este mesmo template (excluídos)', count: 300 },
        ]}
      />,
    );
    const linha = screen.getByTestId('audience-exclusions');
    expect(linha.textContent).toContain('13.400 no público');
    expect(linha.textContent).toContain('300 já estão em campanha com este mesmo template');
  });

  /**
   * Um "0 excluídos" permanente vira ruído e treina o operador a ignorar o
   * aviso justo quando ele importa — a mesma regra do
   * SameTemplateExclusionNotice.
   */
  it('omite as exclusões zeradas', () => {
    render(
      <AudienceExclusionsLine
        total={13400}
        items={[{ label: 'inválidos confirmados (excluídos)', count: 0 }]}
      />,
    );
    expect(screen.getByTestId('audience-exclusions').textContent).not.toContain(
      'inválidos',
    );
  });

  it('não renderiza nada quando não há público nem exclusões', () => {
    const { container } = render(<AudienceExclusionsLine total={0} items={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
