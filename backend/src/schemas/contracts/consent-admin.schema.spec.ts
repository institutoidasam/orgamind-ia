import { describe, it, expect } from 'vitest';
import {
  createPurposeSchema,
  updatePurposeSchema,
  createConsentTextSchema,
  bulkGrantWithPastDateSchema,
} from './consent-admin.schema';

describe('createPurposeSchema', () => {
  const valid = {
    key: 'continuum_avisos',
    label: 'Avisos do CONTINUUM',
    description: 'Comunicados operacionais do programa.',
  };

  it('aceita uma key em snake_case minúsculo', () => {
    const parsed = createPurposeSchema.parse(valid);
    expect(parsed.key).toBe('continuum_avisos');
    // Defaults: finalidade nasce ativa e não-sensível.
    expect(parsed.active).toBe(true);
    expect(parsed.isSensitive).toBe(false);
  });

  it.each([
    ['Continuum_Avisos', 'maiúsculas'],
    ['continuum-avisos', 'hífen'],
    ['continuum avisos', 'espaço'],
    ['continuum.avisos', 'ponto'],
    ['', 'vazia'],
  ])('recusa a key %j (%s)', (key) => {
    const res = createPurposeSchema.safeParse({ ...valid, key });
    expect(res.success).toBe(false);
  });

  it('exige label e description — o texto legal precisa nomear a finalidade', () => {
    expect(createPurposeSchema.safeParse({ ...valid, label: '' }).success).toBe(
      false,
    );
    expect(
      createPurposeSchema.safeParse({ ...valid, description: '' }).success,
    ).toBe(false);
  });
});

describe('updatePurposeSchema', () => {
  it('NÃO deixa trocar a key — ela é a chave estável da trilha', () => {
    const parsed = updatePurposeSchema.parse({
      key: 'outra_key',
      label: 'Novo rótulo',
    }) as Record<string, unknown>;
    expect(parsed.key).toBeUndefined();
    expect(parsed.label).toBe('Novo rótulo');
  });

  it('aceita desativar a finalidade', () => {
    expect(updatePurposeSchema.parse({ active: false }).active).toBe(false);
  });
});

describe('createConsentTextSchema', () => {
  it('exige purposeKey, version e body', () => {
    const parsed = createConsentTextSchema.parse({
      purposeKey: 'continuum_avisos',
      version: 'optin-continuum-v1',
      body: 'Autorizo o CONTINUUM a me enviar mensagens no WhatsApp…',
    });
    expect(parsed.version).toBe('optin-continuum-v1');
  });

  it.each(['purposeKey', 'version', 'body'])('recusa sem %s', (field) => {
    const input: Record<string, string> = {
      purposeKey: 'continuum_avisos',
      version: 'optin-continuum-v1',
      body: 'Autorizo…',
    };
    delete input[field];
    expect(createConsentTextSchema.safeParse(input).success).toBe(false);
  });
});

describe('bulkGrantWithPastDateSchema — a evidência é OBRIGATÓRIA', () => {
  const valid = {
    purposeKey: 'continuum_avisos',
    filters: { combinator: 'and', rules: [] },
    evidenceRef: 'Contrato CONTINUUM #123',
    collectedAt: '2025-03-12',
    evidenceNote: 'Cláusula 7.',
  };

  it('aceita a evidência completa', () => {
    const parsed = bulkGrantWithPastDateSchema.parse(valid);
    expect(parsed.evidenceRef).toBe('Contrato CONTINUUM #123');
    expect(parsed.collectedAt).toBeInstanceOf(Date);
  });

  it('a observação é opcional — a referência e a data não', () => {
    const { evidenceNote, ...semNota } = valid;
    expect(evidenceNote).toBeDefined();
    expect(bulkGrantWithPastDateSchema.safeParse(semNota).success).toBe(true);
  });

  it('recusa sem evidenceRef, em PT-BR', () => {
    const { evidenceRef, ...sem } = valid;
    expect(evidenceRef).toBeDefined();
    const res = bulkGrantWithPastDateSchema.safeParse(sem);

    expect(res.success).toBe(false);
    expect(JSON.stringify(res.error?.issues)).toMatch(/evidência|concordaram/i);
  });

  it('recusa evidenceRef vazia ou curta demais para provar algo', () => {
    expect(
      bulkGrantWithPastDateSchema.safeParse({ ...valid, evidenceRef: '' })
        .success,
    ).toBe(false);
    expect(
      bulkGrantWithPastDateSchema.safeParse({ ...valid, evidenceRef: 'x' })
        .success,
    ).toBe(false);
  });

  it('recusa sem collectedAt, em PT-BR', () => {
    const { collectedAt, ...sem } = valid;
    expect(collectedAt).toBeDefined();
    const res = bulkGrantWithPastDateSchema.safeParse(sem);

    expect(res.success).toBe(false);
    expect(JSON.stringify(res.error?.issues)).toMatch(/data/i);
  });

  it('recusa data de coleta no FUTURO — consentimento que não aconteceu não existe', () => {
    const amanha = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const res = bulkGrantWithPastDateSchema.safeParse({
      ...valid,
      collectedAt: amanha.toISOString(),
    });

    expect(res.success).toBe(false);
    expect(JSON.stringify(res.error?.issues)).toMatch(/passado/i);
  });

  it('recusa filtro malformado — reusa o filterGroupSchema das campanhas', () => {
    const res = bulkGrantWithPastDateSchema.safeParse({
      ...valid,
      filters: { combinator: 'and', rules: [{ field: 'name', op: 'in', value: 'x' }] },
    });
    expect(res.success).toBe(false);
  });
});
