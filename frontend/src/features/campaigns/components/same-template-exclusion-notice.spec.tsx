import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';

import { SameTemplateExclusionNotice } from './same-template-exclusion-notice';

/**
 * ★ DOIS MOTIVOS MUITO DIFERENTES, UMA FRASE SÓ.
 *
 * A régua de exclusão mudou: uma campanha CANCELADA passou a bloquear também as
 * linhas que ficaram em SENT. Em Zernio/GoZap/Evolution não há confirmação de
 * entrega, então SENT é onde a maioria fica presa — inclusive quando o número
 * do canal foi derrubado no meio do disparo, que é justamente quando o operador
 * cancela a campanha e recria em outro canal.
 *
 * Nesse caminho o aviso dizia que a pessoa "já está em campanha com este mesmo
 * template", o que soa como "já recebeu". Ela pode não ter recebido NADA — o
 * número foi banido. Confundir os dois casos leva o operador a desistir de uma
 * audiência inteira achando que ela já foi atendida.
 */
describe('SameTemplateExclusionNotice', () => {
  it('não renderiza nada quando ninguém foi excluído', () => {
    const { container } = render(<SameTemplateExclusionNotice count={0} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('sem a quebra por motivo, não afirma que todos já receberam — avisa do caso da campanha cancelada', () => {
    render(<SameTemplateExclusionNotice count={412} />);

    const aviso = screen.getByTestId('same-template-exclusion');
    expect(aviso).toHaveTextContent('412');
    expect(aviso).toHaveTextContent(/campanha cancelada/i);
    // O ponto todo: o texto não pode prometer entrega que pode não ter havido.
    expect(aviso).toHaveTextContent(/pode não ter recebido|podem não ter recebido/i);
  });

  it('quando ninguém está preso em campanha cancelada, o texto é o simples "já está em campanha"', () => {
    render(<SameTemplateExclusionNotice count={412} stuckInCancelled={0} />);

    const aviso = screen.getByTestId('same-template-exclusion');
    expect(aviso).toHaveTextContent(/já estão em campanha com este mesmo template/i);
    expect(aviso).not.toHaveTextContent(/cancelada/i);
  });

  it('quando TODOS estão presos numa campanha cancelada, o texto fala só disso', () => {
    render(<SameTemplateExclusionNotice count={412} stuckInCancelled={412} />);

    const aviso = screen.getByTestId('same-template-exclusion');
    expect(aviso).toHaveTextContent(/campanha cancelada/i);
    expect(aviso).toHaveTextContent(/pode não ter recebido|podem não ter recebido/i);
    expect(aviso).not.toHaveTextContent(/já receberam esta mensagem/i);
  });

  it('quando os dois casos convivem, cada um aparece com o SEU número', () => {
    render(<SameTemplateExclusionNotice count={412} stuckInCancelled={100} />);

    const aviso = screen.getByTestId('same-template-exclusion');
    expect(aviso).toHaveTextContent(/312/);
    expect(aviso).toHaveTextContent(/100/);
    expect(aviso).toHaveTextContent(/campanha cancelada/i);
  });

  it('fala no singular quando é uma pessoa só', () => {
    render(<SameTemplateExclusionNotice count={1} stuckInCancelled={0} />);

    const aviso = screen.getByTestId('same-template-exclusion');
    expect(aviso).toHaveTextContent(/1 contato não entrou/i);
    expect(aviso).not.toHaveTextContent(/contatos não entraram/i);
  });
});
