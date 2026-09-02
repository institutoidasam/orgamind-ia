// ZB — schema do form "Novo template Zernio" (template COM BOTÕES na Meta).
//
// Espelha a validação pura agregada em PT-BR do backend (backend/src/modules/
// templates/zernio-template-validation.ts): as MENSAGENS daqui são as mesmas,
// para o operador ver o mesmo texto inline antes do request sair. O backend
// continua sendo o backstop — ele é dono do reconhecedor.
//
// ─────────────────────────────────────────────────────────────────────────────
// O QUE ESTE ARQUIVO DELIBERADAMENTE **NÃO** TEM: a lista de rótulos.
//
// O Zernio não transporta payload de quick_reply — o clique de opt-in só é
// reconhecível pelo RÓTULO, contra uma lista FECHADA que vive no backend
// (schemas/contracts/consent-button.schema.ts). Se essa lista fosse COPIADA
// para cá, a cópia divergiria no primeiro rótulo novo — e divergência aqui não
// dá erro: apaga consentimento em silêncio. Então a lista é BUSCADA
// (GET /templates/consent-buttons) e INJETADA no schema. Sem cópia, não há o que
// divergir. Se o fetch falhar, o form DESABILITA o modo consentimento — nunca
// cai num fallback hardcoded, porque o fallback É a divergência.
// ─────────────────────────────────────────────────────────────────────────────
import { z } from 'zod';

/**
 * As categorias que este form pode oferecer. AUTHENTICATION fica de fora — e não
 * é conservadorismo: na Meta um template de autenticação tem forma RÍGIDA (corpo
 * de autenticação fixo + botão OTP/copy-code), não aceita corpo livre nem quick
 * reply arbitrária, e o backend só monta BODY/FOOTER/BUTTONS. Oferecer o caminho
 * era oferecer uma REJEIÇÃO CERTA da Meta 24h depois — mais uma rejeição no
 * histórico da WABA da campanha. (O backend recusa também: é o backstop.)
 */
export const zernioTemplateCategoryEnum = z.enum(['MARKETING', 'UTILITY']);

/** Resposta de GET /templates/consent-buttons — a lista fechada, servida crua. */
export const consentButtonChoicesSchema = z.object({
  optIn: z.array(z.string()),
  optOut: z.array(z.string()),
});
export type ConsentButtonChoices = z.infer<typeof consentButtonChoicesSchema>;

/** Limites da Meta — espelham zernio-template-validation.ts (backend). */
export const ZERNIO_BUTTON_TEXT_MAX = 25;
export const ZERNIO_MAX_QUICK_REPLIES = 3;
export const ZERNIO_MAX_URL_BUTTONS = 2;
export const ZERNIO_BODY_MAX = 1024;
export const ZERNIO_FOOTER_MAX = 60;

const ZERNIO_NAME_REGEX = /^[a-z][a-z0-9_]*$/;
const VARIABLE_TOKEN_REGEX = /\{\{([^}\s]+)\}\}/g;

export const ZERNIO_BUTTON_ROLES = ['OPT_IN', 'OPT_OUT', 'NONE'] as const;
export type ZernioButtonRole = (typeof ZERNIO_BUTTON_ROLES)[number];

export const ZERNIO_BUTTON_ROLE_LABEL: Record<ZernioButtonRole, string> = {
  OPT_IN: 'Opt-in — o clique GRAVA o consentimento',
  OPT_OUT: 'Opt-out — o clique silencia o contato',
  NONE: 'Resposta rápida comum (não mexe em consentimento)',
};

/**
 * A normalização do backend (`squashButton`): NFD sem acento, minúsculo, sem
 * pontuação, espaço colapsado. É uma FUNÇÃO (7 linhas), não uma LISTA — duplicá-la
 * é seguro de um jeito que duplicar a lista jamais seria: se ela divergisse, o
 * teste de comparação com os rótulos buscados quebraria na hora, e ela não muda.
 */
export function squashConsentLabel(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Variáveis NUMERADAS do body, em ordem de primeira aparição. */
export function detectZernioVariables(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(VARIABLE_TOKEN_REGEX)) {
    const name = m[1];
    if (!name || out.includes(name)) continue;
    out.push(name);
  }
  return out;
}

export type ZernioTemplateFormValues = {
  channelId: string;
  name: string;
  language: string;
  category: z.infer<typeof zernioTemplateCategoryEnum>;
  body: string;
  samples: Array<{ variable: string; value: string }>;
  footer: string;
  buttons: Array<{
    type: 'QUICK_REPLY' | 'URL';
    /** Só significa alguma coisa em QUICK_REPLY — botão de URL não gera clique de volta. */
    role: ZernioButtonRole;
    text: string;
    url: string;
  }>;
};

/** Payload de POST /templates/zernio. Sem `buttonId`: o Zernio não tem payload. */
export type CreateZernioTemplateInput = {
  channelId: string;
  name: string;
  language: string;
  category: z.infer<typeof zernioTemplateCategoryEnum>;
  body: string;
  bodyExamples: string[];
  footer?: string;
  buttons: Array<
    | { type: 'QUICK_REPLY'; text: string; role: ZernioButtonRole }
    | { type: 'URL'; text: string; url: string }
  >;
};

const buttonSchema = z.object({
  type: z.enum(['QUICK_REPLY', 'URL']),
  role: z.enum(ZERNIO_BUTTON_ROLES),
  text: z
    .string()
    .min(1, 'O rótulo do botão é obrigatório.')
    .max(
      ZERNIO_BUTTON_TEXT_MAX,
      `No máximo ${ZERNIO_BUTTON_TEXT_MAX} caracteres — a Meta trunca rótulos mais longos, e um rótulo truncado deixa de ser reconhecido no clique.`,
    )
    .refine((t) => !/\{\{[^}\s]+\}\}/.test(t), {
      message: 'O rótulo não pode conter variáveis {{n}}.',
    }),
  url: z.string(),
});

/**
 * O schema do form — construído A PARTIR das escolhas buscadas no backend, e não
 * de uma constante local. É isso que torna a divergência impossível: o que a UI
 * aceita é literalmente o que o backend reconhece.
 */
export function makeZernioTemplateFormSchema(choices: ConsentButtonChoices) {
  const optIn = new Set(choices.optIn.map(squashConsentLabel));
  const optOut = new Set(choices.optOut.map(squashConsentLabel));

  return z
    .object({
      channelId: z.string().min(1, 'Escolha o canal (conta WhatsApp).'),
      name: z
        .string()
        .min(1, 'Nome é obrigatório.')
        .regex(
          ZERNIO_NAME_REGEX,
          'Use apenas letras minúsculas, números e _ , começando por uma letra (ex.: reapresentacao_optin).',
        ),
      language: z.string().min(2),
      category: zernioTemplateCategoryEnum,
      body: z
        .string()
        .min(1, 'Corpo da mensagem é obrigatório.')
        .max(ZERNIO_BODY_MAX, `No máximo ${ZERNIO_BODY_MAX} caracteres.`),
      samples: z.array(
        z.object({
          variable: z.string(),
          // A Meta REJEITA a submissão de um template com {{n}} sem `example`.
          value: z.string().min(1, 'Amostra obrigatória (a Meta exige exemplo).'),
        }),
      ),
      footer: z
        .string()
        .max(ZERNIO_FOOTER_MAX, `No máximo ${ZERNIO_FOOTER_MAX} caracteres.`),
      buttons: z.array(buttonSchema),
    })
    .superRefine((v, ctx) => {
      const named = detectZernioVariables(v.body).filter((t) => !/^\d+$/.test(t));
      if (named.length > 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['body'],
          message: `A Meta só aceita variáveis numeradas ({{1}}, {{2}}, …) — troque: ${named
            .map((t) => `{{${t}}}`)
            .join(', ')}.`,
        });
      }

      const quickReplies = v.buttons.filter((b) => b.type === 'QUICK_REPLY');
      const urlButtons = v.buttons.filter((b) => b.type === 'URL');

      if (quickReplies.length > 0 && urlButtons.length > 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['buttons'],
          message:
            'Não é possível misturar botões de resposta rápida com botões de URL no mesmo template.',
        });
      }
      if (quickReplies.length > ZERNIO_MAX_QUICK_REPLIES) {
        ctx.addIssue({
          code: 'custom',
          path: ['buttons'],
          message: `No máximo ${ZERNIO_MAX_QUICK_REPLIES} botões de resposta rápida por template.`,
        });
      }
      if (urlButtons.length > ZERNIO_MAX_URL_BUTTONS) {
        ctx.addIssue({
          code: 'custom',
          path: ['buttons'],
          message: `No máximo ${ZERNIO_MAX_URL_BUTTONS} botões de URL por template.`,
        });
      }

      const seen = new Map<string, number>();
      v.buttons.forEach((b, i) => {
        const key = squashConsentLabel(b.text);
        if (!key) return;
        const first = seen.get(key);
        if (first !== undefined) {
          ctx.addIssue({
            code: 'custom',
            path: ['buttons', i, 'text'],
            message: `Rótulo igual ao do botão ${first + 1} — o sistema não conseguiria distinguir o clique.`,
          });
        } else {
          seen.set(key, i);
        }

        if (b.type === 'URL' && !/^https:\/\/\S+$/.test(b.url.trim())) {
          ctx.addIssue({
            code: 'custom',
            path: ['buttons', i, 'url'],
            message: 'A URL precisa começar com https://.',
          });
        }
      });

      // ── O CORAÇÃO ───────────────────────────────────────────────────────────
      // Bloqueio, não aviso. A assimetria manda: um operador irritado é barato;
      // achar que colheu 13.400 consentimentos e ter colhido zero, não.
      v.buttons.forEach((b, i) => {
        const key = squashConsentLabel(b.text);
        if (!key) return;

        if (b.type === 'QUICK_REPLY' && b.role === 'OPT_IN' && !optIn.has(key)) {
          ctx.addIssue({
            code: 'custom',
            path: ['buttons', i, 'text'],
            message:
              'Este rótulo NÃO será reconhecido como aceite — o clique da pessoa iria para o lixo e o consentimento seria perdido em silêncio. Escolha um rótulo da lista.',
          });
        }
        if (b.type === 'QUICK_REPLY' && b.role === 'OPT_OUT' && !optOut.has(key)) {
          ctx.addIssue({
            code: 'custom',
            path: ['buttons', i, 'text'],
            message:
              'Este rótulo NÃO será reconhecido como recusa — a pessoa clicaria em "não" e continuaria recebendo. Escolha um rótulo da lista.',
          });
        }
        // A direção INVERSA, que é o buraco que ninguém olha: o reconhecimento
        // no ingest é AGNÓSTICO DE TEMPLATE — um botão "comum" rotulado "Quero
        // receber" grava um aceite que a pessoa não deu.
        if (b.role === 'NONE') {
          if (optOut.has(key)) {
            ctx.addIssue({
              code: 'custom',
              path: ['buttons', i, 'text'],
              message:
                'Este rótulo silencia o contato ao ser clicado. Reescreva o rótulo ou marque o botão como opt-out.',
            });
          } else if (optIn.has(key)) {
            ctx.addIssue({
              code: 'custom',
              path: ['buttons', i, 'text'],
              message:
                'Este rótulo é interpretado como consentimento — um clique aqui gravaria um aceite que a pessoa não deu. Reescreva o rótulo ou marque o botão como opt-in.',
            });
          }
        }
      });

      const optIns = quickReplies.filter((b) => b.role === 'OPT_IN');
      const optOuts = quickReplies.filter((b) => b.role === 'OPT_OUT');
      if (optIns.length > 1) {
        ctx.addIssue({
          code: 'custom',
          path: ['buttons'],
          message: 'Um template pode ter no máximo um botão de opt-in.',
        });
      }
      if (optOuts.length > 1) {
        ctx.addIssue({
          code: 'custom',
          path: ['buttons'],
          message: 'Um template pode ter no máximo um botão de recusa.',
        });
      }
      if (optIns.length > 0 && optOuts.length === 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['buttons'],
          message:
            'Um template de opt-in precisa oferecer também o botão de recusa (opt-out) — sem a saída, o aceite não é livre.',
        });
      }
    });
}

export function buildCreateZernioTemplate(
  values: ZernioTemplateFormValues,
): CreateZernioTemplateInput {
  const footer = values.footer.trim();
  return {
    channelId: values.channelId,
    name: values.name,
    language: values.language,
    category: values.category,
    body: values.body,
    bodyExamples: values.samples.map((s) => s.value),
    ...(footer ? { footer } : {}),
    buttons: values.buttons.map((b) =>
      b.type === 'URL'
        ? { type: 'URL' as const, text: b.text, url: b.url.trim() }
        : { type: 'QUICK_REPLY' as const, text: b.text, role: b.role },
    ),
  };
}

/**
 * O preset que a campanha de reapresentação de fato precisa: o par [Sim] / [Não]
 * semeado com os rótulos CANÔNICOS (os primeiros da lista servida pelo backend —
 * "Sim, quero receber" / "Não quero receber"). O caminho feliz vira um clique,
 * não uma montagem manual onde dá para errar o rótulo.
 */
export function optInPresetButtons(
  choices: ConsentButtonChoices,
): ZernioTemplateFormValues['buttons'] {
  return [
    {
      type: 'QUICK_REPLY',
      role: 'OPT_IN',
      text: choices.optIn[0] ?? '',
      url: '',
    },
    {
      type: 'QUICK_REPLY',
      role: 'OPT_OUT',
      text: choices.optOut[0] ?? '',
      url: '',
    },
  ];
}
