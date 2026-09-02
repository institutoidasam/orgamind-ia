import { describe, it, expect } from 'vitest';
import {
  DomainError,
  NotFoundError,
  ConflictError,
  UnauthorizedError,
  ForbiddenError,
  ValidationError,
  NotImplementedError,
} from './domain.error';

describe('DomainError', () => {
  it('defaults status to 500 when not provided', () => {
    const err = new DomainError({ code: 'some.error', message: 'boom' });
    expect(err.status).toBe(500);
    expect(err.code).toBe('some.error');
    expect(err.message).toBe('boom');
    expect(err.name).toBe('DomainError');
    expect(err).toBeInstanceOf(Error);
  });

  it('keeps explicit status when provided', () => {
    const err = new DomainError({ code: 'x', message: 'm', status: 404 });
    expect(err.status).toBe(404);
  });

  it('preserves detail and cause', () => {
    const cause = new Error('inner');
    const err = new DomainError({
      code: 'x',
      message: 'm',
      status: 422,
      detail: 'too bad',
      cause,
    });
    expect(err.detail).toBe('too bad');
    expect(err.cause).toBe(cause);
  });
});

describe('NotFoundError', () => {
  it('produces resource.not_found code, status 404, detail mentions identifier', () => {
    const err = new NotFoundError('User', 'u1');
    expect(err.code).toBe('user.not_found');
    expect(err.status).toBe(404);
    expect(err.message).toBe('User not found');
    expect(err.detail).toContain('u1');
    expect(err).toBeInstanceOf(DomainError);
    expect(err.name).toBe('NotFoundError');
  });

  it('omits detail when no identifier given', () => {
    const err = new NotFoundError('Contact');
    expect(err.code).toBe('contact.not_found');
    expect(err.detail).toBeUndefined();
  });
});

describe('ConflictError', () => {
  it('has status 409 and default code', () => {
    const err = new ConflictError('Already exists');
    expect(err.status).toBe(409);
    expect(err.code).toBe('conflict');
    expect(err.message).toBe('Already exists');
    expect(err).toBeInstanceOf(DomainError);
  });

  it('accepts custom code', () => {
    const err = new ConflictError('dup', 'contact.duplicate');
    expect(err.code).toBe('contact.duplicate');
  });
});

describe('UnauthorizedError', () => {
  it('defaults to status 401', () => {
    const err = new UnauthorizedError();
    expect(err.status).toBe(401);
    expect(err.code).toBe('unauthorized');
    expect(err.message).toBe('Unauthorized');
    expect(err).toBeInstanceOf(DomainError);
  });
});

describe('ForbiddenError', () => {
  it('defaults to status 403', () => {
    const err = new ForbiddenError();
    expect(err.status).toBe(403);
    expect(err.code).toBe('forbidden');
    expect(err).toBeInstanceOf(DomainError);
  });
});

describe('ValidationError', () => {
  it('defaults to status 400 with validation_failed code', () => {
    const err = new ValidationError('bad input', 'phone is wrong');
    expect(err.status).toBe(400);
    expect(err.code).toBe('validation_failed');
    expect(err.detail).toBe('phone is wrong');
    expect(err).toBeInstanceOf(DomainError);
  });
});

describe('NotImplementedError', () => {
  it('appends a PT-BR suffix to a short feature name by default', () => {
    const err = new NotImplementedError('getSettings');
    expect(err.status).toBe(501);
    expect(err.code).toBe('not_implemented');
    expect(err.message).toBe('getSettings não é suportado pelo provedor ativo');
    expect(err).toBeInstanceOf(DomainError);
  });

  it('uses a full custom message verbatim (no appended suffix) when { full: true }', () => {
    const err = new NotImplementedError(
      'Validação de WhatsApp requer um canal Evolution configurado.',
      { full: true },
    );
    expect(err.message).toBe(
      'Validação de WhatsApp requer um canal Evolution configurado.',
    );
    expect(err.status).toBe(501);
    expect(err.code).toBe('not_implemented');
  });

  it('accepts a custom code alongside a full message', () => {
    const err = new NotImplementedError('mensagem completa', {
      full: true,
      code: 'contact.sync_requires_evolution',
    });
    expect(err.code).toBe('contact.sync_requires_evolution');
  });
});
