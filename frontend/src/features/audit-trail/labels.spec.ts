import { describe, expect, it } from 'vitest';
import {
  actionLabel,
  categoryLabel,
  fieldLabel,
  formatAuditDateTime,
  formatAuditValue,
} from './labels';

describe('rótulos da trilha: ação, tipo e campo', () => {
  it('ação conhecida vira texto; desconhecida mostra o próprio código', () => {
    expect(actionLabel('user.profile_updated')).toBe('Dados da pessoa alterados');
    expect(actionLabel('sector.created')).toBe('Setor criado');
    expect(actionLabel('algo.novo')).toBe('algo.novo');
  });

  it('tipo e campo em português; sem tipo e campo desconhecido não quebram', () => {
    expect(categoryLabel('ASSIGNMENT')).toBe('Vínculo e setor');
    expect(categoryLabel(null)).toBe('Outros');
    expect(fieldLabel('phone')).toBe('Telefone');
    expect(fieldLabel('authorizationSource')).toBe('Origem da autorização');
    expect(fieldLabel('campo_novo')).toBe('campo_novo');
  });

  it('data e hora no fuso do app', () => {
    expect(formatAuditDateTime('2026-11-19T14:30:00.000Z')).toBe('19/11/2026 10:30');
  });
});

describe('valores da trilha por extenso', () => {
  it('referência vira o nome; nulo e vazio viram traço', () => {
    expect(formatAuditValue('sector', { id: 's1', name: 'Logística' })).toBe('Logística');
    expect(formatAuditValue('registration', null)).toBe('—');
    expect(formatAuditValue('jobTitle', '')).toBe('—');
  });

  it('booleano vira Sim/Não; situação vira Ativa/Inativa', () => {
    expect(formatAuditValue('hasAccess', true)).toBe('Sim');
    expect(formatAuditValue('hasAccess', false)).toBe('Não');
    expect(formatAuditValue('isActive', true)).toBe('Ativa');
    expect(formatAuditValue('isActive', false)).toBe('Inativa');
  });

  it('papel, autorização e origem nunca aparecem crus', () => {
    expect(formatAuditValue('role', 'SUPERVISOR')).toBe('Supervisor');
    expect(formatAuditValue('contactAuthorization', 'AUTORIZADO')).toBe('Autorizado');
    expect(formatAuditValue('contactAuthorization', 'NAO_AUTORIZADO')).toBe('Sem autorização');
    expect(formatAuditValue('authorizationSource', 'ACEITE_WHATSAPP')).toBe('Aceite pelo WhatsApp');
    expect(formatAuditValue('authorizationSource', 'CADASTRO_ANTERIOR')).toBe(
      'Cadastro anterior — origem não verificada',
    );
  });

  it('data da autorização vira dd/mm/aaaa; telefone mascarado passa como veio', () => {
    expect(formatAuditValue('authorizationDate', '2026-11-05')).toBe('05/11/2026');
    expect(formatAuditValue('phone', '•••• 1234')).toBe('•••• 1234');
  });
});
