import { describe, it, expect } from 'vitest';
import {
  validateTwilioTemplateInput,
  type TwilioTemplateValidationInput,
} from './twilio-template-validation';

/** Valid twilio/text baseline — each test overrides one aspect to break it. */
function baseInput(
  overrides: Partial<TwilioTemplateValidationInput> = {},
): TwilioTemplateValidationInput {
  return {
    name: 'boas_vindas_v2',
    body: 'Olá {{1}}, seu pedido chegou.',
    variables: { '1': 'João' },
    contentType: 'twilio/text',
    ...overrides,
  };
}

describe('validateTwilioTemplateInput', () => {
  it('retorna [] para um twilio/text válido', () => {
    expect(validateTwilioTemplateInput(baseInput())).toEqual([]);
  });

  describe('nome de aprovação', () => {
    it('rejeita nome com maiúsculas/caracteres inválidos', () => {
      const problems = validateTwilioTemplateInput(
        baseInput({ name: 'BoasVindas-2' }),
      );
      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatch(/nome de aprovação/i);
      expect(problems[0]).toMatch(/minúsculas/);
    });

    it('rejeita nome vazio', () => {
      const problems = validateTwilioTemplateInput(baseInput({ name: '' }));
      expect(problems.some((p) => /nome de aprovação/i.test(p))).toBe(true);
    });

    it('rejeita nome com mais de 512 caracteres', () => {
      const problems = validateTwilioTemplateInput(
        baseInput({ name: 'a'.repeat(513) }),
      );
      expect(problems.some((p) => p.includes('512'))).toBe(true);
    });

    it('aceita nome no limite de 512 caracteres', () => {
      expect(
        validateTwilioTemplateInput(baseInput({ name: 'a'.repeat(512) })),
      ).toEqual([]);
    });
  });

  describe('variáveis do corpo', () => {
    it('rejeita variáveis não-sequenciais ({{1}} e {{3}})', () => {
      const problems = validateTwilioTemplateInput(
        baseInput({
          body: 'Olá {{1}}, veja {{3}} aqui.',
          variables: { '1': 'a', '3': 'b' },
        }),
      );
      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatch(/sequenciais/);
    });

    it('rejeita variável que não começa em {{1}}', () => {
      const problems = validateTwilioTemplateInput(
        baseInput({ body: 'Olá {{2}}, tudo bem?', variables: { '2': 'a' } }),
      );
      expect(problems.some((p) => /sequenciais/.test(p))).toBe(true);
    });

    it('rejeita variável não-numérica', () => {
      const problems = validateTwilioTemplateInput(
        baseInput({ body: 'Olá {{nome}}, tudo bem?', variables: { nome: 'a' } }),
      );
      expect(problems.some((p) => /numéricas/.test(p))).toBe(true);
    });

    it('rejeita corpo que começa com variável', () => {
      const problems = validateTwilioTemplateInput(
        baseInput({ body: '{{1}} chegou seu pedido.' }),
      );
      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatch(/começar com uma variável/);
    });

    it('rejeita corpo que termina com variável', () => {
      const problems = validateTwilioTemplateInput(
        baseInput({ body: 'Seu código é {{1}}' }),
      );
      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatch(/terminar com uma variável/);
    });

    it('rejeita variáveis adjacentes sem separador ({{1}}{{2}})', () => {
      const problems = validateTwilioTemplateInput(
        baseInput({
          body: 'Olá {{1}}{{2}} tudo bem?',
          variables: { '1': 'a', '2': 'b' },
        }),
      );
      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatch(/adjacentes/);
    });

    it('aceita variáveis separadas por espaço ({{1}} {{2}})', () => {
      expect(
        validateTwilioTemplateInput(
          baseInput({
            body: 'Olá {{1}} {{2}} tudo bem?',
            variables: { '1': 'a', '2': 'b' },
          }),
        ),
      ).toEqual([]);
    });

    it('exige amostra para cada variável usada', () => {
      const problems = validateTwilioTemplateInput(
        baseInput({
          body: 'Olá {{1}}, veja {{2}} aqui.',
          variables: { '1': 'João' },
        }),
      );
      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatch(/amostra/i);
      expect(problems[0]).toContain('{{2}}');
    });

    it('rejeita corpo vazio', () => {
      const problems = validateTwilioTemplateInput(baseInput({ body: '' }));
      expect(problems.some((p) => /obrigatório/.test(p))).toBe(true);
    });
  });

  describe('limites por content type', () => {
    it('twilio/text: rejeita corpo com mais de 1600 caracteres', () => {
      const problems = validateTwilioTemplateInput(
        baseInput({ body: 'a'.repeat(1601), variables: {} }),
      );
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain('1600');
    });

    it('twilio/text: aceita corpo no limite de 1600', () => {
      expect(
        validateTwilioTemplateInput(
          baseInput({ body: 'a'.repeat(1600), variables: {} }),
        ),
      ).toEqual([]);
    });

    it('twilio/media: exige ao menos uma URL de mídia', () => {
      const problems = validateTwilioTemplateInput(
        baseInput({ contentType: 'twilio/media' }),
      );
      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatch(/mídia/);
    });

    it('twilio/media: rejeita URL de mídia que não seja https', () => {
      const problems = validateTwilioTemplateInput(
        baseInput({
          contentType: 'twilio/media',
          media: ['http://exemplo.com/foto.jpg'],
        }),
      );
      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatch(/https/);
    });

    it('twilio/media: aceita URL https e corpo até 1600', () => {
      expect(
        validateTwilioTemplateInput(
          baseInput({
            contentType: 'twilio/media',
            media: ['https://exemplo.com/foto.jpg'],
          }),
        ),
      ).toEqual([]);
    });

    it('twilio/quick-reply: rejeita corpo com mais de 1024 caracteres', () => {
      const problems = validateTwilioTemplateInput(
        baseInput({
          contentType: 'twilio/quick-reply',
          body: 'a'.repeat(1025),
          variables: {},
          actions: [{ title: 'Sim', id: 'yes' }],
        }),
      );
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain('1024');
    });

    it('twilio/quick-reply: rejeita título de botão com 21 caracteres', () => {
      const problems = validateTwilioTemplateInput(
        baseInput({
          contentType: 'twilio/quick-reply',
          actions: [{ title: 'x'.repeat(21), id: 'ok' }],
        }),
      );
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain('20');
    });

    it('twilio/quick-reply: aceita título de botão com 20 caracteres', () => {
      expect(
        validateTwilioTemplateInput(
          baseInput({
            contentType: 'twilio/quick-reply',
            actions: [{ title: 'x'.repeat(20), id: 'ok' }],
          }),
        ),
      ).toEqual([]);
    });

    it('twilio/quick-reply: rejeita 11 botões', () => {
      const actions = Array.from({ length: 11 }, (_, i) => ({
        title: `Opção ${i + 1}`,
        id: `op_${i + 1}`,
      }));
      const problems = validateTwilioTemplateInput(
        baseInput({ contentType: 'twilio/quick-reply', actions }),
      );
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain('10');
    });

    it('twilio/quick-reply: exige ao menos um botão', () => {
      const problems = validateTwilioTemplateInput(
        baseInput({ contentType: 'twilio/quick-reply', actions: [] }),
      );
      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatch(/botão|botões/);
    });

    it('twilio/quick-reply: rejeita id (payload) com mais de 200 caracteres', () => {
      const problems = validateTwilioTemplateInput(
        baseInput({
          contentType: 'twilio/quick-reply',
          actions: [{ title: 'Parar', id: 'x'.repeat(201) }],
        }),
      );
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain('200');
    });

    it('twilio/call-to-action: rejeita corpo com mais de 640 caracteres', () => {
      const problems = validateTwilioTemplateInput(
        baseInput({
          contentType: 'twilio/call-to-action',
          body: 'a'.repeat(641),
          variables: {},
          actions: [{ type: 'URL', title: 'Ver site', url: 'https://x.com' }],
        }),
      );
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain('640');
    });

    it('twilio/call-to-action: rejeita 3 botões URL (máx. 2)', () => {
      const problems = validateTwilioTemplateInput(
        baseInput({
          contentType: 'twilio/call-to-action',
          actions: [
            { type: 'URL', title: 'Um', url: 'https://a.com' },
            { type: 'URL', title: 'Dois', url: 'https://b.com' },
            { type: 'URL', title: 'Três', url: 'https://c.com' },
          ],
        }),
      );
      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatch(/2 botões URL/);
    });

    it('twilio/call-to-action: rejeita 2 botões de telefone (máx. 1)', () => {
      const problems = validateTwilioTemplateInput(
        baseInput({
          contentType: 'twilio/call-to-action',
          actions: [
            { type: 'PHONE_NUMBER', title: 'Ligar', phone: '+5592999990000' },
            { type: 'PHONE_NUMBER', title: 'Ligar 2', phone: '+5592999990001' },
          ],
        }),
      );
      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatch(/1 botão de telefone/);
    });

    it('twilio/call-to-action: rejeita título com 21 caracteres', () => {
      const problems = validateTwilioTemplateInput(
        baseInput({
          contentType: 'twilio/call-to-action',
          actions: [{ type: 'URL', title: 'x'.repeat(21), url: 'https://a.com' }],
        }),
      );
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain('20');
    });

    it('twilio/call-to-action: exige url https no botão URL', () => {
      const problems = validateTwilioTemplateInput(
        baseInput({
          contentType: 'twilio/call-to-action',
          actions: [{ type: 'URL', title: 'Ver', url: 'ftp://a.com' }],
        }),
      );
      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatch(/https/);
    });

    it('twilio/call-to-action: exige telefone E.164 no botão de telefone', () => {
      const problems = validateTwilioTemplateInput(
        baseInput({
          contentType: 'twilio/call-to-action',
          actions: [{ type: 'PHONE_NUMBER', title: 'Ligar', phone: '92999' }],
        }),
      );
      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatch(/E\.164/);
    });

    it('twilio/call-to-action: exige ao menos um botão', () => {
      const problems = validateTwilioTemplateInput(
        baseInput({ contentType: 'twilio/call-to-action', actions: [] }),
      );
      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatch(/botão/);
    });

    it('twilio/call-to-action: aceita 2 URL + 1 telefone válidos', () => {
      expect(
        validateTwilioTemplateInput(
          baseInput({
            contentType: 'twilio/call-to-action',
            actions: [
              { type: 'URL', title: 'Site', url: 'https://a.com' },
              { type: 'URL', title: 'Loja', url: 'https://b.com' },
              { type: 'PHONE_NUMBER', title: 'Ligar', phone: '+5592999990000' },
            ],
          }),
        ),
      ).toEqual([]);
    });
  });

  it('lista TODOS os problemas de uma vez (não só o primeiro)', () => {
    const actions = Array.from({ length: 11 }, (_, i) => ({
      title: i === 0 ? 'x'.repeat(21) : `Opção ${i}`,
      id: `op_${i}`,
    }));
    const problems = validateTwilioTemplateInput({
      name: 'Nome Inválido!',
      body: '{{1}}{{4}} sem amostra {{2}}',
      variables: {},
      contentType: 'twilio/quick-reply',
      actions,
    });
    // nome inválido + começa com variável + adjacentes + não-sequencial
    // + amostras faltando + 11 botões + título 21 chars = 7 problemas
    expect(problems.length).toBeGreaterThanOrEqual(6);
    expect(problems.some((p) => /nome de aprovação/i.test(p))).toBe(true);
    expect(problems.some((p) => /começar com uma variável/.test(p))).toBe(true);
    expect(problems.some((p) => /adjacentes/.test(p))).toBe(true);
    expect(problems.some((p) => /sequenciais/.test(p))).toBe(true);
    expect(problems.some((p) => /amostra/i.test(p))).toBe(true);
    expect(problems.some((p) => p.includes('10'))).toBe(true);
    expect(problems.some((p) => p.includes('20'))).toBe(true);
  });
});
