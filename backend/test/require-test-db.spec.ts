import { describe, it, expect } from 'vitest';
import {
  extractDatabaseName,
  isTestDatabaseUrl,
  shouldRunDbTests,
  assertTestDatabase,
} from './require-test-db';

describe('extractDatabaseName', () => {
  it('extrai o nome do banco de uma DATABASE_URL válida', () => {
    expect(extractDatabaseName('postgresql://picoa:picoa@localhost:5432/picoa_dev')).toBe(
      'picoa_dev',
    );
  });

  it('ignora querystring (ex.: ?schema=public)', () => {
    expect(
      extractDatabaseName('postgresql://picoa:picoa@localhost:5432/picoa_test?schema=public'),
    ).toBe('picoa_test');
  });

  it('retorna undefined quando a URL é undefined', () => {
    expect(extractDatabaseName(undefined)).toBeUndefined();
  });

  it('retorna undefined para uma URL inválida', () => {
    expect(extractDatabaseName('nem-url-eh-isso')).toBeUndefined();
  });

  it('retorna undefined quando não há path (sem nome de banco)', () => {
    expect(extractDatabaseName('postgresql://picoa:picoa@localhost:5432/')).toBeUndefined();
  });
});

describe('isTestDatabaseUrl', () => {
  it('true quando o nome do banco termina em "_test"', () => {
    expect(isTestDatabaseUrl('postgresql://u:p@localhost:5432/picoa_test')).toBe(true);
  });

  it('false quando o nome do banco NÃO termina em "_test"', () => {
    expect(isTestDatabaseUrl('postgresql://u:p@localhost:5432/picoa_dev')).toBe(false);
  });

  it('false para "_test" no meio do nome, não no final', () => {
    expect(isTestDatabaseUrl('postgresql://u:p@localhost:5432/picoa_test_backup')).toBe(false);
  });

  it('false quando a URL é undefined', () => {
    expect(isTestDatabaseUrl(undefined)).toBe(false);
  });

  it('false para URL inválida', () => {
    expect(isTestDatabaseUrl('nao-eh-url')).toBe(false);
  });
});

describe('shouldRunDbTests', () => {
  it('true quando PICOA_DB_TESTS=1', () => {
    expect(shouldRunDbTests({ PICOA_DB_TESTS: '1' })).toBe(true);
  });

  it('false quando a env não está setada', () => {
    expect(shouldRunDbTests({})).toBe(false);
  });

  it('false para qualquer valor diferente de "1" (ex.: "true")', () => {
    expect(shouldRunDbTests({ PICOA_DB_TESTS: 'true' })).toBe(false);
  });

  it('false para "0"', () => {
    expect(shouldRunDbTests({ PICOA_DB_TESTS: '0' })).toBe(false);
  });
});

describe('assertTestDatabase', () => {
  it('não lança quando o banco é de teste', () => {
    expect(() =>
      assertTestDatabase('postgresql://u:p@localhost:5432/picoa_test'),
    ).not.toThrow();
  });

  it('lança quando o banco NÃO é de teste, citando o nome do banco', () => {
    expect(() => assertTestDatabase('postgresql://u:p@localhost:5432/picoa_dev')).toThrow(
      /picoa_dev/,
    );
  });

  it('a mensagem de erro explica o que fazer (menciona "_test")', () => {
    expect(() => assertTestDatabase('postgresql://u:p@localhost:5432/picoa_dev')).toThrow(
      /_test/,
    );
  });

  it('lança quando a DATABASE_URL é undefined', () => {
    expect(() => assertTestDatabase(undefined)).toThrow();
  });
});
