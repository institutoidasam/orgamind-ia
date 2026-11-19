import { describe, expect, it } from 'vitest';
import {
  personAuditChanges,
  personAuditSelect,
  type PersonAuditRow,
} from './person-audit';

const ana: PersonAuditRow = {
  name: 'Ana Souza',
  registration: 'AB-12',
  jobTitle: 'Analista',
  phoneE164: '+5592988887777',
  email: 'ana@gbr.com.br',
  role: 'OPERATOR',
  hasAccess: true,
  isActive: true,
  contactAuthorization: 'AUTORIZADO',
  authorizationSource: 'TERMO_ASSINADO',
  authorizationNote: null,
  authorizationDate: new Date('2026-11-19T00:00:00.000Z'),
  sector: { id: 's1', name: 'Logística' },
  workShift: null,
  level: null,
};

describe('personAuditChanges: criação', () => {
  it('lista os campos não nulos com telefone e e-mail mascarados e setor como { id, name }', () => {
    const changes = personAuditChanges(null, ana);
    const byField = Object.fromEntries(changes.map((c) => [c.field, c]));

    expect(byField.phone).toEqual({
      field: 'phone',
      before: null,
      after: '•••• 7777',
    });
    expect(byField.email.after).toBe('a•••@gbr.com.br');
    expect(byField.sector.after).toEqual({ id: 's1', name: 'Logística' });
    expect(byField.authorizationDate.after).toBe('2026-11-19');
    expect(byField.registration.after).toBe('AB-12');
    expect(byField).not.toHaveProperty('shift');
    expect(byField).not.toHaveProperty('authorizationNote');
  });

  it('nenhum valor completo de telefone ou e-mail sai em changes', () => {
    const out = JSON.stringify(personAuditChanges(null, ana));
    expect(out).not.toContain('5592988887777');
    expect(out).not.toContain('988887777');
    expect(out).not.toContain('ana@gbr');
  });

  it('senha nunca entra: nem no select, nem se a linha a trouxer por engano', () => {
    expect(Object.keys(personAuditSelect)).not.toContain('password');
    const hash = '$argon2id$segredo';
    const withHash = { ...ana, password: hash };
    const out = JSON.stringify(personAuditChanges(null, withHash));
    expect(out).not.toContain('password');
    expect(out).not.toContain('argon2');
  });
});

describe('personAuditChanges: edição', () => {
  it('trocar o telefone por outro de mesmo final é uma alteração, com os dois lados mascarados iguais', () => {
    const after = { ...ana, phoneE164: '+5511977777777' };
    const changes = personAuditChanges(ana, after);

    expect(changes).toEqual([
      { field: 'phone', before: '•••• 7777', after: '•••• 7777' },
    ]);
    expect(JSON.stringify(changes)).not.toContain('5511977777777');
  });

  it('trocar o e-mail por outro de mesma inicial e domínio também não vaza o valor cru', () => {
    const changes = personAuditChanges(ana, { ...ana, email: 'a2@gbr.com.br' });

    expect(changes).toEqual([
      { field: 'email', before: 'a•••@gbr.com.br', after: 'a•••@gbr.com.br' },
    ]);
  });

  it('só os campos alterados entram, e renomear o setor não conta', () => {
    const after = {
      ...ana,
      jobTitle: 'Líder',
      sector: { id: 's1', name: 'Logística 2' },
      workShift: { id: 't1', name: 'Manhã' },
    };

    expect(personAuditChanges(ana, after)).toEqual([
      { field: 'jobTitle', before: 'Analista', after: 'Líder' },
      { field: 'shift', before: null, after: { id: 't1', name: 'Manhã' } },
    ]);
  });

  it('sem diferença devolve lista vazia, e sem os dois lados também', () => {
    expect(personAuditChanges(ana, { ...ana })).toEqual([]);
    expect(personAuditChanges(null, null)).toEqual([]);
  });
});
