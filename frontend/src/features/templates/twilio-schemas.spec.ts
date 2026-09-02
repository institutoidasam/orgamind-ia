// twilio-platform T5 — specs do schema/validação do form "Novo template
// Twilio". As mensagens espelham a validação PT-BR agregada do backend
// (backend/src/modules/templates/twilio-template-validation.ts) para o
// operador ver o MESMO texto inline antes do request sair.
import { describe, it, expect } from 'vitest';
import {
  TWILIO_BODY_LIMITS,
  detectTwilioVariables,
  twilioTemplateFormSchema,
  buildCreateTwilioTemplate,
  bumpCloneName,
  cloneTwilioPrefill,
  twilioPrefillFromTemplate,
  type TwilioTemplateFormValues,
} from './twilio-schemas';
import type { Template } from './schemas';

function makeValues(
  overrides: Partial<TwilioTemplateFormValues> = {},
): TwilioTemplateFormValues {
  return {
    name: 'boas_vindas',
    language: 'pt_BR',
    category: 'UTILITY',
    contentType: 'twilio/text',
    body: 'Olá {{1}}, tudo bem?',
    samples: [{ variable: '1', value: 'João' }],
    media: [],
    quickReplies: [],
    ctaUrls: [],
    ctaPhones: [],
    ...overrides,
  };
}

/** All error messages produced by a safeParse, flattened for assertions. */
function problemsOf(values: TwilioTemplateFormValues): string[] {
  const r = twilioTemplateFormSchema.safeParse(values);
  return r.success ? [] : r.error.issues.map((i) => i.message);
}

/** Issues with their paths, for asserting inline placement. */
function issuesOf(values: TwilioTemplateFormValues) {
  const r = twilioTemplateFormSchema.safeParse(values);
  return r.success
    ? []
    : r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
}

describe('detectTwilioVariables', () => {
  it('returns numeric body tokens in ascending order, deduplicated', () => {
    expect(detectTwilioVariables('Oi {{2}} e {{1}} e {{2}}')).toEqual(['1', '2']);
  });

  it('ignores named (non-numeric) tokens — they are reported as body errors', () => {
    expect(detectTwilioVariables('Oi {{nome}} e {{1}}')).toEqual(['1']);
  });

  it('includes variables used in CTA URLs (Twilio allows a trailing URL variable)', () => {
    expect(
      detectTwilioVariables('Acesse seu pedido {{1}} abaixo.', [
        'https://exemplo.com/pedido/{{2}}',
      ]),
    ).toEqual(['1', '2']);
  });
});

describe('twilioTemplateFormSchema — campos comuns', () => {
  it('accepts a valid twilio/text template with variable + sample', () => {
    expect(twilioTemplateFormSchema.safeParse(makeValues()).success).toBe(true);
  });

  it('rejects an invalid approval name with the backend message', () => {
    expect(problemsOf(makeValues({ name: 'Boas Vindas!' }))).toContain(
      'Nome de aprovação inválido: use apenas letras minúsculas, números e underscore (_).',
    );
  });

  it('enforces the per-type body limit (CTA = 640) with the backend message', () => {
    const body = `a${'x'.repeat(700)}`;
    const problems = problemsOf(
      makeValues({
        contentType: 'twilio/call-to-action',
        body,
        samples: [],
        ctaUrls: [{ title: 'Abrir', url: 'https://exemplo.com' }],
      }),
    );
    expect(problems).toContain(
      `O corpo excede o limite de 640 caracteres do tipo twilio/call-to-action (atual: ${body.length}).`,
    );
    expect(TWILIO_BODY_LIMITS['twilio/call-to-action']).toBe(640);
  });

  it('rejects non-sequential variables with the backend message', () => {
    const problems = problemsOf(
      makeValues({
        body: 'Olá {{2}}, tudo bem?',
        samples: [{ variable: '2', value: 'João' }],
      }),
    );
    expect(problems).toContain(
      'Variáveis do corpo devem ser sequenciais a partir de {{1}} — encontradas: {{2}}.',
    );
  });

  it('rejects a body that starts or ends with a variable (backend messages)', () => {
    expect(
      problemsOf(
        makeValues({
          body: '{{1}} chegou.',
          samples: [{ variable: '1', value: 'João' }],
        }),
      ),
    ).toContain('O corpo não pode começar com uma variável.');
    expect(
      problemsOf(
        makeValues({
          body: 'Olá {{1}}',
          samples: [{ variable: '1', value: 'João' }],
        }),
      ),
    ).toContain('O corpo não pode terminar com uma variável.');
  });

  it('rejects directly adjacent variables with the backend message', () => {
    expect(
      problemsOf(
        makeValues({
          body: 'Oi {{1}}{{2}} tchau.',
          samples: [
            { variable: '1', value: 'a' },
            { variable: '2', value: 'b' },
          ],
        }),
      ),
    ).toContain(
      'Variáveis adjacentes sem texto entre elas não são permitidas (ex.: {{1}}{{2}}).',
    );
  });

  it('requires a sample per variable, attached inline to the sample field', () => {
    const issues = issuesOf(
      makeValues({ samples: [{ variable: '1', value: '' }] }),
    );
    expect(issues).toContainEqual({
      path: 'samples.0.value',
      message: 'Amostra obrigatória para {{1}} — informe um valor de exemplo.',
    });
  });
});

describe('twilioTemplateFormSchema — por tipo', () => {
  it('twilio/media requires at least one https URL (backend messages)', () => {
    expect(
      problemsOf(
        makeValues({ contentType: 'twilio/media', media: [] }),
      ),
    ).toContain('twilio/media exige ao menos uma URL de mídia.');
    const issues = issuesOf(
      makeValues({
        contentType: 'twilio/media',
        media: [{ url: 'http://inseguro.com/a.png' }],
      }),
    );
    expect(issues).toContainEqual({
      path: 'media.0.url',
      message: 'URL de mídia deve usar https://.',
    });
  });

  it('twilio/quick-reply requires at least one button', () => {
    expect(
      problemsOf(
        makeValues({ contentType: 'twilio/quick-reply', quickReplies: [] }),
      ),
    ).toContain('twilio/quick-reply exige ao menos um botão.');
  });

  it('caps the quick-reply title at 20 chars with an inline counter message', () => {
    const issues = issuesOf(
      makeValues({
        contentType: 'twilio/quick-reply',
        quickReplies: [{ title: 'x'.repeat(21), id: 'ok' }],
      }),
    );
    expect(issues).toContainEqual({
      path: 'quickReplies.0.title',
      message: 'Título excede 20 caracteres (atual: 21).',
    });
  });

  it('caps the quick-reply id/payload at 200 chars', () => {
    const issues = issuesOf(
      makeValues({
        contentType: 'twilio/quick-reply',
        quickReplies: [{ title: 'Sim', id: 'x'.repeat(201) }],
      }),
    );
    expect(issues).toContainEqual({
      path: 'quickReplies.0.id',
      message: 'Id (payload) excede 200 caracteres (atual: 201).',
    });
  });

  it('CTA requires at least one action and validates https URL + E.164 phone', () => {
    expect(
      problemsOf(makeValues({ contentType: 'twilio/call-to-action' })),
    ).toContain('twilio/call-to-action exige ao menos um botão.');

    const issues = issuesOf(
      makeValues({
        contentType: 'twilio/call-to-action',
        ctaUrls: [{ title: 'Abrir site', url: 'ftp://x' }],
        ctaPhones: [{ title: 'Ligar', phone: '92999' }],
      }),
    );
    expect(issues).toContainEqual({
      path: 'ctaUrls.0.url',
      message: 'URL deve usar https://.',
    });
    expect(issues).toContainEqual({
      path: 'ctaPhones.0.phone',
      message: 'Telefone deve estar em formato E.164 (ex.: +5592999999999).',
    });
  });

  it('does not validate collections of INACTIVE content types', () => {
    // Leftover invalid quick-replies from a previous type choice must not
    // block a twilio/text submit.
    expect(
      twilioTemplateFormSchema.safeParse(
        makeValues({
          contentType: 'twilio/text',
          quickReplies: [{ title: 'x'.repeat(50), id: '' }],
          ctaPhones: [{ title: '', phone: 'nope' }],
        }),
      ).success,
    ).toBe(true);
  });

  it('samples cover variables used in CTA URLs too', () => {
    const issues = issuesOf(
      makeValues({
        contentType: 'twilio/call-to-action',
        body: 'Seu pedido está pronto.',
        samples: [{ variable: '1', value: '' }],
        ctaUrls: [{ title: 'Abrir', url: 'https://x.com/{{1}}' }],
      }),
    );
    expect(issues).toContainEqual({
      path: 'samples.0.value',
      message: 'Amostra obrigatória para {{1}} — informe um valor de exemplo.',
    });
  });
});

function makeTemplate(overrides: Partial<Template> = {}): Template {
  return {
    id: 't1',
    metaName: 'primeiro_contato',
    language: 'pt_BR',
    body: 'Olá {{1}}, podemos falar?',
    variables: ['1'],
    status: 'REJECTED',
    category: 'UTILITY',
    createdAt: new Date('2026-07-01T00:00:00Z'),
    kind: 'TEXT',
    interactiveConfig: null,
    twilioContentSid: 'HX0123456789abcdef0123456789abcdef',
    provider: 'TWILIO',
    twilioApprovalStatus: 'rejected',
    twilioRejectionReason: 'INVALID_FORMAT',
    lastTwilioSyncAt: new Date('2026-07-10T00:00:00Z'),
    ...overrides,
  };
}

describe('bumpCloneName', () => {
  it('appends _v2 to a plain name', () => {
    expect(bumpCloneName('primeiro_contato')).toBe('primeiro_contato_v2');
  });

  it('increments an existing _vN suffix instead of stacking', () => {
    expect(bumpCloneName('primeiro_contato_v2')).toBe('primeiro_contato_v3');
    expect(bumpCloneName('promo_v9')).toBe('promo_v10');
  });
});

describe('twilioPrefillFromTemplate / cloneTwilioPrefill', () => {
  it('prefills a twilio/text template with empty sample values (amostras não são persistidas localmente)', () => {
    const prefill = twilioPrefillFromTemplate(makeTemplate());
    expect(prefill).toMatchObject({
      name: 'primeiro_contato',
      language: 'pt_BR',
      category: 'UTILITY',
      contentType: 'twilio/text',
      body: 'Olá {{1}}, podemos falar?',
      samples: [{ variable: '1', value: '' }],
      quickReplies: [],
      ctaUrls: [],
      ctaPhones: [],
    });
  });

  it('detects quick-reply from the interactiveConfig round-trip shape', () => {
    const prefill = twilioPrefillFromTemplate(
      makeTemplate({
        kind: 'BUTTONS',
        interactiveConfig: {
          'twilio/quick-reply': {
            body: 'Deseja continuar recebendo avisos?',
            actions: [
              { title: 'Sim', id: 'sim' },
              { title: 'Parar', id: 'optout' },
            ],
          },
        },
      }),
    );
    expect(prefill.contentType).toBe('twilio/quick-reply');
    expect(prefill.quickReplies).toEqual([
      { title: 'Sim', id: 'sim' },
      { title: 'Parar', id: 'optout' },
    ]);
  });

  it('detects CTA actions and media from the stored config', () => {
    const cta = twilioPrefillFromTemplate(
      makeTemplate({
        interactiveConfig: {
          'twilio/call-to-action': {
            body: 'Fale com a equipe.',
            actions: [
              { type: 'URL', title: 'Abrir', url: 'https://x.com/{{1}}' },
              { type: 'PHONE_NUMBER', title: 'Ligar', phone: '+5592995550101' },
            ],
          },
        },
        body: 'Fale com a equipe.',
      }),
    );
    expect(cta.contentType).toBe('twilio/call-to-action');
    expect(cta.ctaUrls).toEqual([{ title: 'Abrir', url: 'https://x.com/{{1}}' }]);
    expect(cta.ctaPhones).toEqual([
      { title: 'Ligar', phone: '+5592995550101' },
    ]);
    // variável usada na URL do CTA também gera amostra
    expect(cta.samples).toEqual([{ variable: '1', value: '' }]);

    const media = twilioPrefillFromTemplate(
      makeTemplate({
        interactiveConfig: {
          'twilio/media': { body: 'Veja o anexo.', media: ['https://x.com/a.png'] },
        },
        body: 'Veja o anexo.',
      }),
    );
    expect(media.contentType).toBe('twilio/media');
    expect(media.media).toEqual([{ url: 'https://x.com/a.png' }]);
  });

  it('cloneTwilioPrefill sufixa o nome com _v2 (só prefill — cria um NOVO draft)', () => {
    const clone = cloneTwilioPrefill(makeTemplate());
    expect(clone.name).toBe('primeiro_contato_v2');
    expect(clone.body).toBe('Olá {{1}}, podemos falar?');
  });
});

describe('buildCreateTwilioTemplate', () => {
  it('builds a twilio/text payload with variables map and no media/actions', () => {
    expect(buildCreateTwilioTemplate(makeValues())).toEqual({
      name: 'boas_vindas',
      language: 'pt_BR',
      category: 'UTILITY',
      contentType: 'twilio/text',
      body: 'Olá {{1}}, tudo bem?',
      variables: { '1': 'João' },
    });
  });

  it('builds a twilio/media payload with the media URL list', () => {
    const payload = buildCreateTwilioTemplate(
      makeValues({
        contentType: 'twilio/media',
        media: [{ url: 'https://exemplo.com/a.png' }],
      }),
    );
    expect(payload.media).toEqual(['https://exemplo.com/a.png']);
    expect(payload.actions).toBeUndefined();
  });

  it('builds quick-reply actions as {title, id}', () => {
    const payload = buildCreateTwilioTemplate(
      makeValues({
        contentType: 'twilio/quick-reply',
        quickReplies: [
          { title: 'Sim', id: 'sim' },
          { title: 'Parar', id: 'optout' },
        ],
      }),
    );
    expect(payload.actions).toEqual([
      { title: 'Sim', id: 'sim' },
      { title: 'Parar', id: 'optout' },
    ]);
  });

  it('builds CTA actions with URL first and PHONE_NUMBER type for phones', () => {
    const payload = buildCreateTwilioTemplate(
      makeValues({
        contentType: 'twilio/call-to-action',
        ctaUrls: [{ title: 'Abrir site', url: 'https://exemplo.com' }],
        ctaPhones: [{ title: 'Ligar', phone: '+5592995550101' }],
      }),
    );
    expect(payload.actions).toEqual([
      { type: 'URL', title: 'Abrir site', url: 'https://exemplo.com' },
      { type: 'PHONE_NUMBER', title: 'Ligar', phone: '+5592995550101' },
    ]);
  });

  it('drops samples of variables no longer present in the body', () => {
    const payload = buildCreateTwilioTemplate(
      makeValues({
        body: 'Sem variáveis.',
        samples: [{ variable: '1', value: 'obsoleta' }],
      }),
    );
    expect(payload.variables).toEqual({});
  });
});
