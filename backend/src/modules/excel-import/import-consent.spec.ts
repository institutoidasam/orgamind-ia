import { describe, it, expect } from 'vitest';
import {
  CONSENT_COLUMN_KEYS,
  parseCollectedAt,
  parseConsentFlag,
  parsePaperConsent,
} from './import-consent';

describe('parseConsentFlag — a coluna `consentimento` de uma ficha de campo', () => {
  it('reconhece o SIM em todas as formas que saem de uma planilha de verdade', () => {
    for (const v of ['SIM', 'sim', ' Sim ', 'S', 's', 'X', 'x', 'TRUE', '1']) {
      expect(parseConsentFlag(v)).toBe(true);
    }
  });

  it('reconhece o NÃO — inclusive sem acento e abreviado', () => {
    for (const v of ['NÃO', 'NAO', 'não', 'N', 'n', 'FALSE', '0']) {
      expect(parseConsentFlag(v)).toBe(false);
    }
  });

  it('célula vazia/ausente é AUSENTE, nunca "não" e muito menos "sim"', () => {
    expect(parseConsentFlag(undefined)).toBeNull();
    expect(parseConsentFlag('')).toBeNull();
    expect(parseConsentFlag('   ')).toBeNull();
  });

  it('valor que não é nem sim nem não NÃO vira consentimento (não se adivinha)', () => {
    expect(parseConsentFlag('talvez')).toBeNull();
    expect(parseConsentFlag('ok')).toBeNull();
  });
});

describe('parseCollectedAt — a data em que a pessoa ASSINOU', () => {
  it('aceita a ISO que o exceljs produz para célula de data', () => {
    expect(parseCollectedAt('2026-03-15')?.toISOString().slice(0, 10)).toBe('2026-03-15');
  });

  it('aceita o formato que o brasileiro digita', () => {
    expect(parseCollectedAt('15/03/2026')?.toISOString().slice(0, 10)).toBe('2026-03-15');
  });

  it('recusa lixo e vazio — data inventada faria um termo velho parecer fresco', () => {
    expect(parseCollectedAt('')).toBeNull();
    expect(parseCollectedAt('semana passada')).toBeNull();
    expect(parseCollectedAt('99/99/2026')).toBeNull();
  });
});

describe('parsePaperConsent — §3.3, o que a linha da planilha autoriza', () => {
  const FULL = {
    telefone: '(92) 98765-4321',
    consentimento: 'SIM',
    termo_ref: 'TERMO-CAMPO-2026-A',
    finalidade: 'convite_atividades',
    data_coleta: '2026-03-15',
    evento_local: 'Mutirão de Parintins',
    link_scan: 'https://drive.exemplo.org/fichas/123.pdf',
  };

  it('SIM + termo + finalidade + data → GRANT, com a origem toda preservada', () => {
    const parsed = parsePaperConsent(FULL, null);

    expect(parsed.kind).toBe('granted');
    if (parsed.kind !== 'granted') return;
    expect(parsed.intent).toMatchObject({
      purposeKey: 'convite_atividades',
      termRef: 'TERMO-CAMPO-2026-A',
      eventName: 'Mutirão de Parintins',
      scanUrl: 'https://drive.exemplo.org/fichas/123.pdf',
    });
    // occurredAt = a data da ASSINATURA, não a do import. A distinção é a regra
    // de frescor do §3.3: um termo de 8 meses É um consentimento antigo.
    expect(parsed.intent.collectedAt.toISOString().slice(0, 10)).toBe('2026-03-15');
  });

  it('sem coluna de consentimento → AUSENTE (o contato entra, o consentimento não)', () => {
    const parsed = parsePaperConsent({ telefone: '(92) 98765-4321', nome: 'Maria' }, null);
    expect(parsed.kind).toBe('absent');
  });

  it('consentimento = NÃO → recusa explícita, jamais um GRANT', () => {
    const parsed = parsePaperConsent({ ...FULL, consentimento: 'NAO' }, null);
    expect(parsed.kind).toBe('refused');
  });

  it('a finalidade pode vir do PARÂMETRO do import quando a planilha não tem a coluna', () => {
    const { finalidade: _drop, ...semColuna } = FULL;
    const parsed = parsePaperConsent(semColuna, 'captacao_recursos');

    expect(parsed.kind).toBe('granted');
    if (parsed.kind !== 'granted') return;
    expect(parsed.intent.purposeKey).toBe('captacao_recursos');
  });

  it('a coluna da linha VENCE o parâmetro do import (a ficha é a fonte)', () => {
    const parsed = parsePaperConsent(FULL, 'captacao_recursos');
    expect(parsed.kind === 'granted' && parsed.intent.purposeKey).toBe('convite_atividades');
  });

  it('SIM sem referência ao termo assinado → INCOMPLETO: "autorizo contato" genérico não é opt-in', () => {
    const { termo_ref: _drop, ...semTermo } = FULL;
    const parsed = parsePaperConsent(semTermo, null);

    expect(parsed.kind).toBe('incomplete');
    expect(parsed.kind === 'incomplete' && parsed.reason).toMatch(/termo/i);
  });

  it('SIM sem finalidade (nem na linha, nem no import) → INCOMPLETO (art. 8º §4º)', () => {
    const { finalidade: _drop, ...semFinalidade } = FULL;
    const parsed = parsePaperConsent(semFinalidade, null);

    expect(parsed.kind).toBe('incomplete');
    expect(parsed.kind === 'incomplete' && parsed.reason).toMatch(/finalidade/i);
  });

  it('SIM sem data de coleta → INCOMPLETO: gravar `hoje` faria um termo velho parecer fresco', () => {
    const { data_coleta: _drop, ...semData } = FULL;
    const parsed = parsePaperConsent(semData, null);

    expect(parsed.kind).toBe('incomplete');
    expect(parsed.kind === 'incomplete' && parsed.reason).toMatch(/data/i);
  });

  it('aceita `versao_termo` (o nome da spec) como sinônimo de `termo_ref`', () => {
    const { termo_ref: _drop, ...raw } = FULL;
    const parsed = parsePaperConsent({ ...raw, versao_termo: 'TERMO-V2' }, null);
    expect(parsed.kind === 'granted' && parsed.intent.termRef).toBe('TERMO-V2');
  });

  it('as colunas de consentimento são CONHECIDAS — não podem vazar para customFields', () => {
    expect(CONSENT_COLUMN_KEYS).toEqual(
      expect.arrayContaining([
        'consentimento',
        'termo_ref',
        'versao_termo',
        'finalidade',
        'data_coleta',
        'evento_local',
        'link_scan',
        'hash_scan',
      ]),
    );
  });
});
