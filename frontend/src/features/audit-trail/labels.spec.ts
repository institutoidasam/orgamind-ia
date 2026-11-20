import { describe, expect, it } from 'vitest';
import {
  actionLabel,
  categoryLabel,
  fieldLabel,
  formatAuditDateTime,
  formatAuditValue,
} from './labels';

describe('rótulos da trilha: importação de planilhas', () => {
  it('ações e campos da importação traduzidos', () => {
    expect(actionLabel('people_import.confirmed')).toBe('Confirmou importação de pessoas');
    expect(actionLabel('people_import.completed')).toBe('Terminou importação de pessoas');
    const fields: Record<string, string> = {
      fileName: 'Arquivo',
      toCreate: 'A criar',
      toUpdate: 'A atualizar',
      created: 'Criadas',
      updated: 'Atualizadas',
      unchanged: 'Sem alteração',
      invalid: 'Inválidas',
      duplicate: 'Duplicadas',
      conflict: 'Conflitos',
      failed: 'Falhas',
      phoneTaken: 'Falhas por telefone já cadastrado',
      notWritten: 'Não gravadas',
      writing: 'Em gravação no encerramento',
      ending: 'Fim',
    };
    for (const [field, label] of Object.entries(fields)) expect(fieldLabel(field)).toBe(label);
    expect(fieldLabel('rowCount')).toBe('Linhas');
  });

  it('fim da importação nunca aparece cru; contador vira número', () => {
    expect(formatAuditValue('ending', 'COMPLETED')).toBe('Concluída');
    expect(formatAuditValue('ending', 'CLOSED')).toBe('Encerrada pelo administrador');
    expect(formatAuditValue('ending', 'AUTO_CLOSED')).toBe('Encerrada automaticamente');
    expect(formatAuditValue('phoneTaken', 2)).toBe('2');
  });
});

describe('rótulos da trilha: planilhas', () => {
  it('categoria Planilhas e ações Exportou pessoas e Exportou escala', () => {
    expect(categoryLabel('SPREADSHEET')).toBe('Planilhas');
    expect(actionLabel('people.export')).toBe('Exportou pessoas');
    expect(actionLabel('schedule.export')).toBe('Exportou escala');
  });

  it('campos da exportação com rótulo e valores traduzidos', () => {
    expect(fieldLabel('format')).toBe('Formato');
    expect(fieldLabel('statusFilter')).toBe('Situação');
    expect(fieldLabel('referenceDate')).toBe('Data de referência');
    expect(fieldLabel('rowCount')).toBe('Linhas');
    expect(fieldLabel('phoneVisibility')).toBe('Telefone');
    expect(fieldLabel('periodFrom')).toBe('De');
    expect(fieldLabel('periodTo')).toBe('Até');
    expect(formatAuditValue('statusFilter', 'active')).toBe('Ativas');
    expect(formatAuditValue('statusFilter', 'inactive')).toBe('Inativas');
    expect(formatAuditValue('statusFilter', 'all')).toBe('Todas');
    expect(formatAuditValue('phoneVisibility', 'full')).toBe('Completo');
    expect(formatAuditValue('phoneVisibility', 'masked')).toBe('Mascarado');
    expect(formatAuditValue('phoneVisibility', 'partial')).toBe('Completo em parte');
    expect(formatAuditValue('referenceDate', '2026-11-19')).toBe('19/11/2026');
    expect(formatAuditValue('periodFrom', '2026-11-01')).toBe('01/11/2026');
    expect(formatAuditValue('periodTo', '2026-11-30')).toBe('30/11/2026');
  });
});

describe('rótulos da trilha: permissões por papel', () => {
  it('campo <chave>:<PAPEL> vira "<nome da permissão> (<Papel>)", sem chave nem papel crus', () => {
    expect(fieldLabel('escala.alterar:OPERATOR')).toBe('Alterar a escala (Operador)');
    expect(fieldLabel('estrutura.manter:SUPERVISOR')).toBe('Manter setores, turnos e níveis (Supervisor)');
  });

  it('chave ou papel desconhecido mantém o texto como veio, sem quebrar', () => {
    expect(fieldLabel('escala.alterar:ROOT')).toBe('escala.alterar:ROOT');
    expect(fieldLabel('chave.nova:OPERATOR')).toBe('chave.nova:OPERATOR');
    expect(fieldLabel('toString:OPERATOR')).toBe('toString:OPERATOR');
    expect(fieldLabel('escala.alterar:OPERATOR:x')).toBe('escala.alterar:OPERATOR:x');
  });

  it('valor da célula alterada vira Sim ou Não', () => {
    expect(formatAuditValue('escala.alterar:OPERATOR', true)).toBe('Sim');
    expect(formatAuditValue('escala.alterar:OPERATOR', false)).toBe('Não');
  });

  it('ações da matriz em português', () => {
    expect(actionLabel('permission.matrix_updated')).toBe('Permissões alteradas');
    expect(actionLabel('permission.matrix_restored')).toBe('Permissões restauradas ao padrão');
  });
});

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
