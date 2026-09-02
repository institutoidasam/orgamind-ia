import { describe, it, expect } from 'vitest';
import { ContactSourceOrigin } from '@prisma/client';
import {
  classifyContact,
  hasImportDeclaration,
  type ContactSignals,
} from './source-origin.classifier';

const base: ContactSignals = {
  contactId: 'c1',
  whatsappValid: null,
  lastInteractionAt: null,
  importRows: [],
};

describe('classifyContact — coortes de procedência (spec §6.2)', () => {
  describe('C5 — INVÁLIDOS / NÃO-WHATSAPP', () => {
    it('whatsappValid=false exclui, mesmo com interação e planilha com declaração', () => {
      const result = classifyContact({
        ...base,
        whatsappValid: false,
        lastInteractionAt: new Date('2026-07-01T10:00:00Z'),
        importRows: [
          { filename: 'inscritos_curso_2023.xlsx', raw: { consentimento: 'sim' } },
        ],
      });

      // "C5 exclui; depois C1 > C2 > C3 > C4" — disparar para número morto queima
      // cota do tier e a Twilio marca o tráfego como lower-quality.
      expect(result.origin).toBe(ContactSourceOrigin.INVALIDO_NAO_WHATSAPP);
    });

    it('nunca checado (whatsappValid=null) NÃO é C5 — é procedência a classificar', () => {
      // A spec lista "ou nunca checado" em C5, mas C5 EXCLUI: numa base de 13k em
      // que ninguém foi checado, isso zeraria C1–C4 e a auditoria inteira não
      // diria nada. O não-checado é reportado à parte no painel (§7) e a ação
      // continua sendo a mesma: rodar o reachability check antes de disparar.
      const result = classifyContact({
        ...base,
        whatsappValid: null,
        lastInteractionAt: new Date('2026-07-01T10:00:00Z'),
      });

      expect(result.origin).toBe(ContactSourceOrigin.INTERAGIU);
    });
  });

  describe('C1 — INTERAGIU', () => {
    it('quem tem inbound tem relação demonstrável e vence C2/C3/C4', () => {
      const result = classifyContact({
        ...base,
        lastInteractionAt: new Date('2026-06-30T12:00:00Z'),
        importRows: [
          { filename: 'inscritos_curso_2023.xlsx', raw: { consentimento: 'sim' } },
        ],
      });

      expect(result.origin).toBe(ContactSourceOrigin.INTERAGIU);
      expect(result.note).toMatch(/inbound/i);
    });

    it('interação NÃO é consentimento — a nota diz isso em letras (é o bug do §1)', () => {
      const result = classifyContact({
        ...base,
        lastInteractionAt: new Date('2026-06-30T12:00:00Z'),
      });

      expect(result.note).toMatch(/não é consentimento/i);
    });
  });

  describe('C2 — ORIGEM DOCUMENTADA COM DECLARAÇÃO', () => {
    it('linha de planilha com declaração afirmativa de recebimento', () => {
      const result = classifyContact({
        ...base,
        importRows: [
          { filename: 'feira_2025.xlsx', raw: { nome: 'Ana', consentimento: 'SIM' } },
        ],
      });

      expect(result.origin).toBe(ContactSourceOrigin.DOCUMENTADA_COM_DECLARACAO);
      expect(result.note).toContain('feira_2025.xlsx');
      expect(result.note).toContain('consentimento');
    });

    it('reconhece a coluna da planilha legada por sinônimo e acento ("autorização")', () => {
      const result = classifyContact({
        ...base,
        importRows: [{ filename: 'legado.xlsx', raw: { 'autorização': 'x' } }],
      });

      expect(result.origin).toBe(ContactSourceOrigin.DOCUMENTADA_COM_DECLARACAO);
    });

    it('basta UMA linha declarar — o contato pode ter vindo em vários lotes', () => {
      const result = classifyContact({
        ...base,
        importRows: [
          { filename: 'lista_presenca.xlsx', raw: { nome: 'Ana' } },
          { filename: 'termo_feira.xlsx', raw: { aceite: 'sim' } },
        ],
      });

      expect(result.origin).toBe(ContactSourceOrigin.DOCUMENTADA_COM_DECLARACAO);
    });
  });

  describe('C3 — ORIGEM DOCUMENTADA SEM DECLARAÇÃO', () => {
    it('folha de presença que só coletou nome e telefone não é opt-in', () => {
      const result = classifyContact({
        ...base,
        importRows: [
          { filename: 'lista_presenca_curso_x_2023.xlsx', raw: { nome: 'Ana', telefone: '92999...' } },
        ],
      });

      expect(result.origin).toBe(ContactSourceOrigin.DOCUMENTADA_SEM_DECLARACAO);
      expect(result.note).toContain('lista_presenca_curso_x_2023.xlsx');
    });

    it('"não" declarado na planilha é o oposto de declaração — continua C3', () => {
      const result = classifyContact({
        ...base,
        importRows: [{ filename: 'feira.xlsx', raw: { consentimento: 'nao' } }],
      });

      expect(result.origin).toBe(ContactSourceOrigin.DOCUMENTADA_SEM_DECLARACAO);
    });

    it('"talvez" não é sim — adivinhar a intenção é a fabricação que a feature fecha', () => {
      const result = classifyContact({
        ...base,
        importRows: [{ filename: 'feira.xlsx', raw: { consentimento: 'talvez' } }],
      });

      expect(result.origin).toBe(ContactSourceOrigin.DOCUMENTADA_SEM_DECLARACAO);
    });
  });

  describe('C4 — PROCEDÊNCIA DESCONHECIDA', () => {
    it('sem ImportItem e sem interação: não enviar NADA por WhatsApp', () => {
      const result = classifyContact(base);

      expect(result.origin).toBe(ContactSourceOrigin.DESCONHECIDA);
      expect(result.note).toMatch(/nenhum lote de importação/i);
    });

    it('lote sem origem rastreável (arquivo sem nome) não documenta procedência', () => {
      const result = classifyContact({
        ...base,
        importRows: [{ filename: '', raw: { nome: 'Ana' } }],
      });

      expect(result.origin).toBe(ContactSourceOrigin.DESCONHECIDA);
    });
  });

  describe('hasImportDeclaration', () => {
    it.each([
      ['consentimento', 'sim'],
      ['aceite', 's'],
      ['autoriza contato', 'x'],
      ['opt-in', 'true'],
      ['permissao', '1'],
    ])('coluna "%s" = "%s" declara recebimento', (key, value) => {
      expect(hasImportDeclaration({ [key]: value })).not.toBeNull();
    });

    it.each([
      ['nome', 'sim'],
      ['cidade', 'sim'],
      ['consentimento', ''],
      ['consentimento', 'nao'],
    ])('coluna "%s" = "%s" NÃO declara nada', (key, value) => {
      expect(hasImportDeclaration({ [key]: value })).toBeNull();
    });
  });
});
