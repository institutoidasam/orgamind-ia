import { describe, expect, it } from 'vitest';
import type { DomainError } from '../../shared/errors/domain.error';
import {
  handlerDetail,
  notHandler,
  pendencyChanged,
  pendencyNotFound,
  pendencyTaken,
} from './team-pendency.errors';

const view = (e: DomainError) => ({
  code: e.code,
  status: e.status,
  message: e.message,
});

describe('erros da pendência (DK15, C3)', () => {
  it('pendencyTaken — 409 com detail { handler: { id, name } }', () => {
    const error = pendencyTaken({ id: 'u1', name: 'Gestor S1' });
    expect(error.status).toBe(409);
    expect(error.code).toBe('team_whatsapp.pendency_taken');
    expect(JSON.parse(error.detail ?? '')).toEqual({
      handler: { id: 'u1', name: 'Gestor S1' },
    });
  });

  it('pendencyChanged — 409; detail com handler null', () => {
    const error = pendencyChanged(null);
    expect(error.status).toBe(409);
    expect(error.code).toBe('team_whatsapp.pendency_changed');
    expect(JSON.parse(error.detail ?? '')).toEqual({ handler: null });
    expect(
      JSON.parse(pendencyChanged({ id: 'u2', name: 'N' }).detail ?? ''),
    ).toEqual({ handler: { id: 'u2', name: 'N' } });
  });

  it('pendencyTaken com responsável sem nome — detail com handler null', () => {
    const error = pendencyTaken({ id: 'u3', name: '' });
    expect(error.code).toBe('team_whatsapp.pendency_taken');
    expect(JSON.parse(error.detail ?? '')).toEqual({ handler: null });
  });

  it('handlerDetail copia só id e nome, nunca campo extra do objeto passado', () => {
    const richer = { id: 'u1', name: 'Gestor S1', phone: '+5592991110001' };
    expect(JSON.parse(handlerDetail(richer))).toEqual({
      handler: { id: 'u1', name: 'Gestor S1' },
    });
  });

  it('notHandler — 403 team_whatsapp.not_handler; pendencyNotFound — 404', () => {
    expect(view(notHandler())).toEqual({
      code: 'team_whatsapp.not_handler',
      status: 403,
      message: 'Só o responsável ou um administrador pode fazer isso.',
    });
    expect(view(pendencyNotFound())).toEqual({
      code: 'team_whatsapp.pendency_not_found',
      status: 404,
      message: 'Pendência não encontrada.',
    });
  });
});
