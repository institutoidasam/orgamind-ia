/**
 * Validação PRÉ-Zernio de templates COM BOTÕES — e o fecho do LOOP DO RÓTULO.
 *
 * Duas responsabilidades, e a segunda é a razão de existir do arquivo:
 *
 * 1. Regras de forma da Meta (nome, variáveis, limites de botão) validadas ANTES
 *    do POST remoto, agregando TODOS os problemas em PT-BR de uma vez — mesmo
 *    padrão de `twilio-template-validation.ts`. Aqui isso vale mais do que lá:
 *    um template já submetido à Meta é IMUTÁVEL, e a fila de aprovação leva até
 *    24h. Cada round-trip de correção custa um dia da janela da campanha.
 *
 * 2. O CASAMENTO DO RÓTULO. O Zernio não transporta payload de quick_reply — o
 *    clique só é reconhecível pelo RÓTULO, contra a lista fechada do
 *    `consent-button.schema`. Um rótulo de opt-in fora dessa lista derruba TODO
 *    clique, em silêncio. Então aqui é BLOQUEIO, não aviso: quem é dono do
 *    reconhecedor é quem aprova o rótulo, no MESMO processo, sem cópia. Um front
 *    desatualizado, um curl ou um bundle em cache não conseguem criar um template
 *    que colhe zero.
 *
 * Função pura (sem I/O) — o form do frontend espelha as MENSAGENS, e o backend
 * continua sendo o backstop.
 */
import {
  CONSENT_BUTTON_TEXT_MAX,
  auditConsentButtons,
  squashButton,
  type ConsentButtonRole,
} from '../../schemas/contracts/consent-button.schema';

/**
 * O papel de um botão no fluxo de consentimento. O TIPO e a REGRA moram no
 * `consent-button.schema` (o dono do reconhecedor) — aqui só reexportamos, para
 * que o form, a validação e o gate de campanha falem do mesmo papel.
 */
export type ZernioButtonRole = ConsentButtonRole;

export type ZernioQuickReplyInput = {
  type: 'QUICK_REPLY';
  /** O rótulo — o ÚNICO campo que o operador controla (não há id/payload). */
  text: string;
  role?: ZernioButtonRole;
};

export type ZernioUrlButtonInput = {
  type: 'URL';
  text: string;
  url: string;
};

export type ZernioTemplateButtonInput =
  ZernioQuickReplyInput | ZernioUrlButtonInput;

export type ZernioTemplateValidationInput = {
  /** Nome de aprovação da Meta: `^[a-z][a-z0-9_]*$` (mais estrito que o metaName local). */
  name: string;
  language: string;
  category: 'MARKETING' | 'UTILITY' | 'AUTHENTICATION';
  body: string;
  /** Amostra por variável, na ORDEM ({{1}} → [0]). A Meta rejeita sem `example`. */
  bodyExamples?: string[];
  footer?: string;
  buttons?: ZernioTemplateButtonInput[];
};

/** `^[a-z][a-z0-9_]*$` — o regex do Zernio (não pode começar com dígito). */
const ZERNIO_NAME_REGEX = /^[a-z][a-z0-9_]*$/;
const ZERNIO_NAME_MAX = 512;
const ZERNIO_BODY_MAX = 1024;
const ZERNIO_FOOTER_MAX = 60;

/** Rótulo de botão: o teto da Meta. Acima disso a Meta TRUNCA — e um rótulo
 *  truncado não é mais reconhecido no clique. Ver consent-button.schema. */
export const ZERNIO_BUTTON_TEXT_MAX = CONSENT_BUTTON_TEXT_MAX;

/**
 * Teto CONSERVADOR de quick replies. A única fonte in-tree sobre o limite da
 * Meta é o `.max(3)` de `buttonsConfigSchema` ("max 3 per WhatsApp limits"), e o
 * dossiê do Zernio (§3.2) não enumera limites de botão de TEMPLATE — o `≤3/≤13`
 * documentado lá é da mensagem de SESSÃO, que é outra coisa.
 *
 * Errar para MENOS é inofensivo (a campanha de opt-in usa 2). Errar para MAIS
 * custa 24h de fila e uma REJEIÇÃO da Meta. TODO: confirmar o teto real contra a
 * doc da Meta antes de liberar mais.
 */
export const ZERNIO_MAX_QUICK_REPLIES = 3;

/** Idem: 2 é o teto que o repo já assume para CTA de URL (Twilio). */
export const ZERNIO_MAX_URL_BUTTONS = 2;

const VARIABLE_TOKEN_REGEX = /\{\{([^}\s]+)\}\}/g;

/**
 * As categorias que este endpoint sabe MONTAR. AUTHENTICATION fica de fora, e
 * não é conservadorismo gratuito: na Meta um template de autenticação tem forma
 * RÍGIDA (corpo de autenticação fixo + botão OTP/copy-code), não aceita corpo
 * livre nem quick reply arbitrária, e o `buildZernioComponents` só sabe emitir
 * BODY/FOOTER/BUTTONS(QUICK_REPLY|URL) — não existe OTP no schema. Oferecer o
 * caminho seria oferecer uma REJEIÇÃO CERTA da Meta 24h depois, e mais uma
 * rejeição no histórico da WABA da campanha.
 */
const ZERNIO_SUPPORTED_CATEGORIES = ['MARKETING', 'UTILITY'] as const;

function isQuickReply(
  b: ZernioTemplateButtonInput,
): b is ZernioQuickReplyInput {
  return b.type === 'QUICK_REPLY';
}

/**
 * Valida o input de criação de template Zernio. Devolve TODOS os problemas
 * (PT-BR); lista vazia = válido.
 */
export function validateZernioTemplateInput(
  input: ZernioTemplateValidationInput,
): string[] {
  const problems: string[] = [];

  validateName(input.name, problems);
  validateCategory(input.category, problems);
  validateBody(input, problems);
  validateFooter(input.footer, problems);
  validateButtons(input.buttons ?? [], problems);

  return problems;
}

function validateCategory(category: string, problems: string[]): void {
  if (
    !(ZERNIO_SUPPORTED_CATEGORIES as readonly string[]).includes(category ?? '')
  ) {
    problems.push(
      `Categoria não suportada aqui: ${category}. Use MARKETING ou UTILITY — um template AUTHENTICATION tem forma rígida na Meta (corpo fixo + botão de código) e seria rejeitado, deixando mais uma rejeição no histórico da conta.`,
    );
  }
}

function validateName(name: string, problems: string[]): void {
  const value = (name ?? '').trim();
  if (!value) {
    problems.push('Nome é obrigatório.');
    return;
  }
  if (value.length > ZERNIO_NAME_MAX) {
    problems.push(`Nome deve ter no máximo ${ZERNIO_NAME_MAX} caracteres.`);
  }
  if (!ZERNIO_NAME_REGEX.test(value)) {
    problems.push(
      'Nome inválido: use apenas letras minúsculas, números e _ , começando por uma letra (ex.: reapresentacao_optin).',
    );
  }
}

function validateBody(
  input: ZernioTemplateValidationInput,
  problems: string[],
): void {
  const body = (input.body ?? '').trim();
  if (!body) {
    problems.push('Corpo da mensagem é obrigatório.');
    return;
  }
  if (body.length > ZERNIO_BODY_MAX) {
    problems.push(
      `Corpo da mensagem deve ter no máximo ${ZERNIO_BODY_MAX} caracteres (atual: ${body.length}).`,
    );
  }

  const tokens = [...body.matchAll(VARIABLE_TOKEN_REGEX)].map((m) => m[1]);
  const named = tokens.filter((t) => !/^\d+$/.test(t));
  if (named.length > 0) {
    // A Meta só aceita variáveis POSICIONAIS em template. `{{nome}}` passa no
    // extractTemplateVariables do orgamind (que é permissivo) e é REJEITADO lá.
    problems.push(
      `A Meta só aceita variáveis numeradas ({{1}}, {{2}}, …) — troque: ${[
        ...new Set(named),
      ]
        .map((t) => `{{${t}}}`)
        .join(', ')}.`,
    );
  }

  const numbers = [...new Set(tokens.filter((t) => /^\d+$/.test(t)))].map(
    Number,
  );
  numbers.sort((a, b) => a - b);
  const sequential = numbers.every((n, i) => n === i + 1);
  if (numbers.length > 0 && !sequential) {
    problems.push(
      'As variáveis precisam ser sequenciais a partir de {{1}} (ex.: {{1}}, {{2}}).',
    );
  }

  // A Meta EXIGE `example` sempre que houver {{n}} — sem isso a submissão é
  // rejeitada (dossiê §3.2). Sem amostra, o operador só descobre 24h depois.
  const examples = (input.bodyExamples ?? []).filter((v) => v?.trim());
  if (numbers.length > 0 && examples.length !== numbers.length) {
    problems.push(
      `Cada variável precisa de uma amostra (a Meta rejeita a submissão sem exemplo): ${numbers.length} variável(is), ${examples.length} amostra(s).`,
    );
  }
}

function validateFooter(footer: string | undefined, problems: string[]): void {
  if (footer && footer.length > ZERNIO_FOOTER_MAX) {
    problems.push(`Rodapé deve ter no máximo ${ZERNIO_FOOTER_MAX} caracteres.`);
  }
}

function validateButtons(
  buttons: ZernioTemplateButtonInput[],
  problems: string[],
): void {
  if (buttons.length === 0) return;

  const quickReplies = buttons.filter(isQuickReply);
  const urlButtons = buttons.filter((b) => b.type === 'URL');

  // ── Forma (limites da Meta) ───────────────────────────────────────────────
  if (quickReplies.length > 0 && urlButtons.length > 0) {
    problems.push(
      'Não é possível misturar botões de resposta rápida com botões de URL no mesmo template.',
    );
  }
  if (quickReplies.length > ZERNIO_MAX_QUICK_REPLIES) {
    problems.push(
      `No máximo ${ZERNIO_MAX_QUICK_REPLIES} botões de resposta rápida por template (enviados: ${quickReplies.length}).`,
    );
  }
  if (urlButtons.length > ZERNIO_MAX_URL_BUTTONS) {
    problems.push(
      `No máximo ${ZERNIO_MAX_URL_BUTTONS} botões de URL por template (enviados: ${urlButtons.length}).`,
    );
  }

  const seen = new Map<string, number>();
  for (const [i, button] of buttons.entries()) {
    const n = i + 1;
    const text = (button.text ?? '').trim();
    if (!text) {
      problems.push(`Botão ${n}: o rótulo é obrigatório.`);
      continue;
    }
    if (text.length > ZERNIO_BUTTON_TEXT_MAX) {
      problems.push(
        `Botão ${n} ("${text}"): o rótulo deve ter no máximo ${ZERNIO_BUTTON_TEXT_MAX} caracteres — a Meta trunca rótulos mais longos, e um rótulo truncado deixa de ser reconhecido no clique.`,
      );
    }
    if (VARIABLE_TOKEN_REGEX.test(text)) {
      VARIABLE_TOKEN_REGEX.lastIndex = 0;
      problems.push(
        `Botão ${n} ("${text}"): o rótulo não pode conter variáveis {{n}}.`,
      );
    }
    VARIABLE_TOKEN_REGEX.lastIndex = 0;

    // Rótulos que colapsam no mesmo valor squashado são indistinguíveis PARA O
    // RECONHECEDOR — dois botões assim tornariam o clique ambíguo.
    const key = squashButton(text);
    const first = seen.get(key);
    if (first !== undefined) {
      problems.push(
        `Botões ${first} e ${n} têm rótulos iguais ("${text}") — o sistema não conseguiria distinguir o clique.`,
      );
    } else {
      seen.set(key, n);
    }

    if (button.type === 'URL') {
      validateUrlButton(button, n, problems);
    }
  }

  // O CASAMENTO DO RÓTULO — o reconhecedor é quem aprova, no MESMO processo.
  // Aqui todo quick reply TEM papel declarado (o zod dá default 'NONE'), então
  // o ramo "não declarado" da auditoria não dispara: o operador é obrigado a
  // dizer o que cada botão significa, e a auditoria confere contra a lista.
  problems.push(
    ...auditConsentButtons(
      quickReplies.map((b) => ({
        position: buttons.indexOf(b) + 1,
        text: b.text,
        role: b.role ?? 'NONE',
      })),
    ),
  );
}

function validateUrlButton(
  button: ZernioUrlButtonInput,
  n: number,
  problems: string[],
): void {
  const url = (button.url ?? '').trim();
  if (!url) {
    problems.push(`Botão ${n}: botão de URL exige uma URL.`);
    return;
  }
  if (!/^https:\/\/\S+$/.test(url)) {
    problems.push(`Botão ${n}: a URL precisa começar com https://.`);
  }
  // Um clique em botão de URL NÃO gera mensagem de entrada nenhuma — não há
  // clique para reconhecer, logo não há como registrar aceite por ele.
  const role = (button as { role?: ZernioButtonRole }).role;
  if (role === 'OPT_IN' || role === 'OPT_OUT') {
    problems.push(
      `Botão ${n}: um botão de URL não pode ser de consentimento — o clique num link não volta como mensagem, então o aceite nunca seria registrado. Use um botão de resposta rápida.`,
    );
  }
}

/**
 * Os `components` da Meta, no shape EXATO que vai no `POST /whatsapp/templates`
 * e que o `syncFromZernio` vai reescrever por cima (round-trip fiel).
 *
 * SEM `id`/`payload` no botão: o Zernio não tem esse campo, e inventá-lo seria
 * mentir para o operador — o reconhecimento é pelo `text`, e só.
 *
 * CASE: `type` em MAIÚSCULO. O OpenAPI do Zernio declara minúsculo, mas o exemplo
 * oficial usa MAIÚSCULO e a LISTAGEM devolve MAIÚSCULO — mandar o que a listagem
 * devolve mantém o round-trip do sync coerente. (Dossiê §3.2 registra o gotcha e
 * manda testar num template descartável; `extractZernioBody` já aceita os dois.)
 */
export function buildZernioComponents(
  input: ZernioTemplateValidationInput,
): unknown[] {
  const components: unknown[] = [];

  const examples = (input.bodyExamples ?? []).filter((v) => v?.trim());
  components.push({
    type: 'BODY',
    text: input.body,
    // `body_text` é ARRAY DE ARRAYS (uma linha de exemplo por conjunto).
    ...(examples.length > 0 && { example: { body_text: [examples] } }),
  });

  if (input.footer?.trim()) {
    components.push({ type: 'FOOTER', text: input.footer.trim() });
  }

  const buttons = input.buttons ?? [];
  if (buttons.length > 0) {
    components.push({
      type: 'BUTTONS',
      buttons: buttons.map((b) =>
        b.type === 'URL'
          ? { type: 'URL', text: b.text, url: b.url }
          : { type: 'QUICK_REPLY', text: b.text },
      ),
    });
  }

  return components;
}

/**
 * Os rótulos EFETIVOS dos botões como a Meta os guardou, lidos de volta dos
 * `components` que o Zernio devolve. Usado no round-trip pós-criação: se a Meta
 * normalizou/truncou o rótulo do botão de opt-in a ponto de ele não ser mais
 * reconhecido, é melhor descobrir agora do que depois de 13.400 cliques mudos.
 */
export function extractZernioButtonTexts(components: unknown): string[] {
  if (!Array.isArray(components)) return [];
  for (const c of components) {
    if (typeof c !== 'object' || c === null) continue;
    const comp = c as Record<string, unknown>;
    if (String(comp.type ?? '').toUpperCase() !== 'BUTTONS') continue;
    const buttons = Array.isArray(comp.buttons) ? comp.buttons : [];
    return buttons
      .map((b) =>
        typeof b === 'object' && b !== null
          ? String((b as Record<string, unknown>).text ?? '')
          : '',
      )
      .filter(Boolean);
  }
  return [];
}
