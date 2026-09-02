/**
 * O VOCABULÁRIO DE CONSENTIMENTO — fonte ÚNICA da verdade.
 *
 * Este arquivo é PURO (zero `@nestjs`, zero `@prisma`, zero I/O), como todo o
 * resto de `schemas/contracts/`. Isso é o que permite que a MESMA função que lê
 * o clique no webhook (`ZernioCloudAdapter` → `chat-ingest`) seja a que APROVA o
 * rótulo na criação do template (`TemplatesService.createZernio`) e a que
 * alimenta o picker da UI (`GET /templates/consent-buttons`). Um reconhecedor,
 * um lugar, nenhuma cópia.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUE ISTO EXISTE (leia antes de mexer)
 *
 * O Zernio NÃO deixa definir o id/payload de um botão quick_reply — nem na
 * criação do template (o schema BUTTONS do OpenAPI é `{type, text, url, …}`,
 * sem `id`/`payload`), nem no envio (`POST /inbox/conversations` só tem
 * `templateParams` posicional). O que chega quando a pessoa toca o botão é o
 * RÓTULO. Logo o sistema só consegue reconhecer o clique pelo rótulo — e o
 * reconhecimento é uma LISTA FECHADA.
 *
 * Consequência operacional: um botão de opt-in rotulado fora desta lista
 * ("Bora!", "Quero sim", "Aceito") derruba TODO clique, em silêncio. O operador
 * acha que colheu 13.400 consentimentos e colheu zero.
 *
 * Por isso `CONSENT_BUTTON_CHOICES` (o que a UI OFERECE) é testado, em
 * `consent-button.schema.spec.ts`, contra `isZernioOptInButton`/
 * `isZernioOptOutButton` (o que o webhook RECONHECE): se as duas listas
 * divergirem, o teste fica VERMELHO em vez de o consentimento sumir.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Extraído VERBATIM de `zernio-cloud.adapter.ts` (que agora importa daqui) —
 * nenhuma regra de reconhecimento foi alterada nesta extração, de propósito: o
 * comportamento do ingest não pode mudar por causa de um form.
 */

/**
 * O valor canônico que o handler de opt-out casa (`webhooks.service` casa
 * `buttonPayload === 'optout'` e grava ConsentSource.WA_BUTTON +
 * suppressionReason `button_optout`). Os templates Twilio definem esse literal
 * como id do botão; Zernio/Meta não deixam escolher o id do botão NATIVO de
 * opt-out de marketing, então o adapter normaliza para ele.
 */
export const OPT_OUT_BUTTON = 'optout';

/** Forma insensível a caixa e acento, para casar payloads e rótulos. */
export function foldButton(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // tira diacríticos combinantes
    .toLowerCase()
    .trim();
}

/**
 * Tokens de opt-out de VALOR INTEIRO. Espelha deliberadamente o `STOP_REGEX` do
 * `webhooks.service` para que TOCAR o botão e DIGITAR a palavra sejam tratados
 * igual — um id de botão `PARAR` tem de suprimir exatamente como a palavra-chave.
 */
const OPT_OUT_TOKENS = new Set([
  'optout',
  'opt out',
  'opt-out',
  'opt_out',
  'stop',
  'parar',
  'pare',
  'sair',
  'cancelar',
  'cancel',
  'nao',
  'unsubscribe',
  'descadastrar',
]);

/**
 * Substrings do botão NATIVO de opt-out de marketing da Meta, cujo payload é o
 * RÓTULO LOCALIZADO ("Parar promoções" / "Stop promotions") e não um id que
 * escolhemos — então casar token inteiro não basta.
 */
const OPT_OUT_PHRASES = [
  'parar promo',
  'stop promo',
  'nao quero receber',
  'nao receber',
  'cancelar inscricao',
  'sair da lista',
  'descadastr',
  'unsubscribe',
  'opt out',
];

/**
 * Verdadeiro quando QUALQUER um dos sinais (payload/id do botão e rótulo
 * visível) significa "pare de me mandar mensagem".
 *
 * O viés é deliberado: um falso positivo suprime um contato que tocou um botão
 * ambíguo; um falso negativo segue metralhando MARKETING em quem pediu para
 * parar — o que derruba a qualidade do número e restringe a WABA. Pegamos o erro
 * barato, não o fatal.
 */
export function isZernioOptOutButton(
  ...signals: Array<string | undefined>
): boolean {
  return signals.some((raw) => {
    if (!raw) return false;
    const v = foldButton(raw);
    if (!v) return false;
    return OPT_OUT_TOKENS.has(v) || OPT_OUT_PHRASES.some((p) => v.includes(p));
  });
}

/**
 * O valor canônico que o handler de opt-in casa (`chat-ingest` casa
 * `buttonPayload === 'optin_yes'` e grava ConsentAction.GRANT +
 * ConsentSource.WA_BUTTON).
 *
 * Mesmo defeito estrutural do OPT_OUT_BUTTON, e mordeu do mesmo jeito: este
 * literal é um id de botão que NÓS escolhemos, mas o endpoint de envio do Zernio
 * não tem campo nenhum para payload de quick_reply — só `templateParams`
 * posicional. O id nunca sai do app e nunca volta: o que chega no toque é o
 * RÓTULO ("Sim, quero receber"). A igualdade exata lá em cima falhava, e cada
 * clique de opt-in era descartado em silêncio. O adapter normaliza para o
 * literal, exatamente como já fazia no opt-out.
 */
export const OPT_IN_BUTTON = 'optin_yes';

/**
 * `foldButton` + remoção de pontuação/símbolo/emoji e colapso de espaço:
 * "Sim, quero receber!" → "sim quero receber". Usado SÓ para igualdade de valor
 * inteiro contra a lista fechada abaixo — nunca para substring.
 */
export function squashButton(value: string | undefined): string {
  if (!value) return '';
  return foldButton(value)
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * A lista FECHADA de valores de botão que significam "sim, pode me mandar
 * mensagem" — casada por igualdade de VALOR INTEIRO na forma squashada. Nunca
 * teste de substring.
 *
 * Duas regras governam o que pode entrar aqui, e as duas sustentam o prédio:
 *
 * 1. NUNCA SUBSTRING. Em português o afirmativo é substring do negativo: "não
 *    quero receber" CONTÉM "quero receber". Um `includes()` aqui transforma um
 *    toque no botão NÃO em consentimento gravado — o inverso exato da vontade da
 *    pessoa, escrito num livro-razão append-only.
 *
 * 2. NADA DE AFIRMATIVA GENÉRICA ("Sim", "OK", "Confirmo", "Aceito", "Quero") e
 *    NADA DE RÓTULO QUE SÓ AUTORIZA *ENVIAR ALGO* ("Pode enviar", "Autorizo o
 *    envio"). Rótulo de botão é texto livre que um operador digita no form: um
 *    template não relacionado ("Podemos enviar seu comprovante?" → [Pode enviar]
 *    / [Agora não]) fabricaria um GRANT. O conjunto admissível é definido por uma
 *    REGRA, não por gosto:
 *
 *      uma entrada só qualifica SE nomeia o RECEBIMENTO de mensagens
 *      (receber / recebimento / receive / subscribe), ou é um id de opt-in que
 *      nós mesmos escolhemos (`optin_yes`).
 *
 * O custo dessa estreiteza é um falso NEGATIVO quando o operador escreve um
 * rótulo que não conhecemos ("Bora!"): o clique não grava nada e a pessoa pode
 * clicar de novo. Esse é o erro barato. O caro — um ConsentEvent dizendo que
 * alguém concordou sem ter concordado — é irreversível, e numa campanha
 * eleitoral sobre dado sensível é a pior coisa que este sistema pode fazer.
 *
 * CONSEQUÊNCIA OPERACIONAL: o botão SIM do template TEM de ser rotulado com um
 * destes. É por isso que `CONSENT_BUTTON_CHOICES` existe e é a ÚNICA coisa que a
 * UI oferece — e é por isso que a criação de template BLOQUEIA um rótulo fora da
 * lista, em vez de avisar.
 */
const OPT_IN_LABELS = new Set([
  // ids que controlamos (ids de quick-reply estilo Twilio; idempotentes quando chegam)
  'optin yes', // forma squashada de `optin_yes` / `optin-yes`
  'optin',
  'opt in',
  // pt-BR — toda entrada NOMEIA o recebimento das mensagens
  'sim quero receber',
  'sim quero receber mensagens',
  'sim quero receber as mensagens',
  'sim quero receber novidades',
  'quero receber',
  'quero receber mensagens',
  'quero receber novidades',
  'sim aceito receber',
  'aceito receber',
  'aceito receber mensagens',
  'autorizo o recebimento',
  'sim autorizo o recebimento',
  // en (templates bilíngues)
  'yes i want to receive',
  'yes subscribe',
]);

/**
 * Qualquer palavra de negação/saída, como PALAVRA INTEIRA, em qualquer posição.
 * Cinto e suspensório: a checagem de opt-out já roda antes e vence, então isto é
 * redundante por construção — de propósito. É a trava que sobrevive a alguém
 * acrescentar uma entrada descuidada em OPT_IN_LABELS ano que vem: um valor que
 * carrega "nao" nunca vira "sim", diga a lista o que disser.
 */
const OPT_IN_NEGATION =
  /(^|\s)(nao|n|nunca|jamais|stop|pare|parar|sair|cancelar|cancel|descadastrar|unsubscribe|prefiro|talvez|depois)(\s|$)/;

/**
 * Verdadeiro quando um botão TOCADO significa "sim, pode me mandar mensagem".
 *
 * O viés aqui é o OPOSTO do de `isZernioOptOutButton`, e a assimetria é o
 * desenho inteiro. Lá, um falso positivo custa um contato super-suprimido e um
 * falso negativo queima a WABA — então casa frouxo. Aqui, um falso positivo
 * FABRICA consentimento: um ConsentEvent irreversível afirmando que uma pessoa
 * autorizou contato sem ter autorizado. Um falso negativo só perde um clique que
 * a pessoa pode repetir. Na dúvida: não grava.
 *
 * Daí três travas empilhadas, nesta ordem:
 *   1. opt-out tem precedência ABSOLUTA — qualquer sinal de "não" desqualifica;
 *   2. negação como palavra inteira em qualquer lugar desqualifica;
 *   3. só então, igualdade de valor inteiro contra a lista fechada.
 */
export function isZernioOptInButton(
  ...signals: Array<string | undefined>
): boolean {
  // Trava 1. Alimenta também as formas squashadas, para que uma vírgula não
  // contrabandeie um "não" por baixo das opt-out phrases ("Não, quero receber"
  // dobra para "nao, quero receber", que OPT_OUT_PHRASES não pega). Isto só
  // ALARGA a classe negativa, que é a direção segura.
  if (isZernioOptOutButton(...signals, ...signals.map(squashButton)))
    return false;

  return signals.some((raw) => {
    const v = squashButton(raw);
    if (!v) return false;
    if (OPT_IN_NEGATION.test(v)) return false; // Trava 2
    return OPT_IN_LABELS.has(v); // Trava 3 — valor inteiro, nunca substring
  });
}

/**
 * O teto de caracteres do rótulo de um botão de template na Meta.
 *
 * Não é decoração: um rótulo mais longo é TRUNCADO, e o rótulo truncado que volta
 * no clique não bate mais com a lista fechada — o consentimento sumiria em
 * silêncio, exatamente o bug que este módulo existe para fechar. Por isso
 * `CONSENT_BUTTON_CHOICES` só contém rótulos que cabem, e o spec prova isso.
 *
 * É também por isso que entradas legítimas de OPT_IN_LABELS ficam de FORA do
 * picker: "sim quero receber as mensagens" (30) continua sendo RECONHECIDA (um
 * template criado fora do orgamind pode usá-la), mas não é OFERECÍVEL como botão.
 */
export const CONSENT_BUTTON_TEXT_MAX = 25;

/**
 * O que a UI OFERECE ao operador — na forma de EXIBIÇÃO (com acento e
 * pontuação), que é o que vai literalmente no botão do WhatsApp.
 *
 * Invariantes, garantidos por teste (consent-button.schema.spec.ts):
 *   - todo rótulo de `optIn` passa em `isZernioOptInButton` e NÃO em
 *     `isZernioOptOutButton`;
 *   - todo rótulo de `optOut` passa em `isZernioOptOutButton` e NÃO em
 *     `isZernioOptInButton`;
 *   - todos cabem em `CONSENT_BUTTON_TEXT_MAX`.
 *
 * Servido cru pelo `GET /templates/consent-buttons` — o frontend NÃO tem cópia
 * desta lista, e por isso não há o que divergir. Se o fetch falhar, a UI
 * DESABILITA o modo consentimento; nunca cai num fallback hardcoded (o fallback
 * É a divergência).
 */
/**
 * O papel de um botão no fluxo de consentimento — DECLARADO pelo operador e
 * CONFERIDO contra o reconhecedor.
 *
 * `NONE` não é "não me valide": é "este botão NÃO pode ser lido como aceite nem
 * como recusa". O reconhecimento no ingest é AGNÓSTICO DE TEMPLATE (o payload é
 * sintetizado a partir do rótulo de QUALQUER botão de QUALQUER template), então
 * um quick reply "comum" rotulado "Quero receber" FABRICARIA um GRANT.
 */
export type ConsentButtonRole = 'OPT_IN' | 'OPT_OUT' | 'NONE';

/** Uma declaração persistida (`Template.consentButtonRoles`). */
export type DeclaredConsentButton = { text: string; role: ConsentButtonRole };

const CONSENT_BUTTON_ROLES: ReadonlySet<string> = new Set([
  'OPT_IN',
  'OPT_OUT',
  'NONE',
]);

/**
 * Lê a coluna `Template.consentButtonRoles` (Json) de volta para o tipo. Json de
 * banco é `unknown` de verdade: uma row antiga, um write manual ou um shape que
 * mudou não podem virar exceção no meio do gate de campanha — o que não parse
 * simplesmente NÃO EXISTE (e "não declarado" é o estado seguro, que BLOQUEIA).
 */
export function readDeclaredConsentButtons(
  raw: unknown,
): DeclaredConsentButton[] {
  if (!Array.isArray(raw)) return [];
  const out: DeclaredConsentButton[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const text = typeof e.text === 'string' ? e.text.trim() : '';
    const role = typeof e.role === 'string' ? e.role : '';
    if (!text || !CONSENT_BUTTON_ROLES.has(role)) continue;
    out.push({ text, role: role as ConsentButtonRole });
  }
  return out;
}

/**
 * Os rótulos dos botões de RESPOSTA RÁPIDA como a Meta os guardou, lidos dos
 * `components`. É o que volta no clique — e portanto a única coisa que o
 * reconhecedor vai ver. Botões de URL ficam de fora de propósito: o clique num
 * link não gera mensagem nenhuma, então não há clique para reconhecer.
 */
export function extractQuickReplyLabels(components: unknown): string[] {
  if (!Array.isArray(components)) return [];
  for (const c of components) {
    const comp = asRecord(c);
    // O `type` vem MAIÚSCULO na listagem, mas o OpenAPI declara minúsculo —
    // aceitar os dois custa uma linha e evita um catálogo silenciosamente sem
    // botões (o que faria o gate achar que não há nada a auditar).
    if (readString(comp?.type).toUpperCase() !== 'BUTTONS') continue;
    const buttons = Array.isArray(comp?.buttons) ? comp.buttons : [];
    return buttons
      .map((b) => asRecord(b))
      .filter((b) => readString(b?.type).toUpperCase() === 'QUICK_REPLY')
      .map((b) => readString(b?.text).trim())
      .filter(Boolean);
  }
  return [];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Um botão a auditar. `role` AUSENTE = papel NÃO declarado (ver auditConsentButtons). */
export type AuditableButton = {
  /** 1-based, só para a mensagem de erro ("Botão 2 (…)"). */
  position: number;
  text: string;
  role?: ConsentButtonRole;
};

/**
 * ★ O CORAÇÃO — a auditoria que fecha o loop entre o rótulo que o operador
 * escreve e o rótulo que o código reconhece. Um lugar, três chamadores:
 *
 *   - `validateZernioTemplateInput` (criação pelo orgamind) → bloqueia ANTES do POST;
 *   - `TemplatesService.declareConsentButtons` (classificação de um template
 *     importado do painel do Zernio) → bloqueia a declaração incoerente;
 *   - o GATE DE CAMPANHA → bloqueia o disparo de um template cujos cliques o
 *     sistema não sabe ler.
 *
 * `role` ausente significa "ninguém declarou o papel deste botão" — o caso dos
 * templates criados FORA do orgamind, que o sync importa. Aí o papel é INFERIDO do
 * próprio reconhecedor (é literalmente o que vai acontecer no ingest), e se o
 * reconhecedor não sabe ler o rótulo, o botão é um PROBLEMA: pode ser um
 * "Ver mais" inofensivo ou pode ser o "Bora, quero!" de um opt-in que jogaria
 * 13.400 cliques no lixo — e do rótulo sozinho é INDECIDÍVEL qual dos dois é.
 * Quem decide é o operador, declarando o papel; até lá, não passa.
 *
 * Devolve TODOS os problemas em PT-BR (lista vazia = ok).
 */
export function auditConsentButtons(buttons: AuditableButton[]): string[] {
  const problems: string[] = [];
  let optIns = 0;
  let optOuts = 0;

  for (const b of buttons) {
    const text = (b.text ?? '').trim();
    if (!text) continue;

    const recognizedOptOut = isZernioOptOutButton(text);
    const recognizedOptIn = isZernioOptInButton(text);

    // Papel não declarado → inferido do reconhecedor. Opt-out tem precedência
    // aqui pelo mesmo motivo de sempre: suprimir demais é o erro barato.
    const role: ConsentButtonRole | undefined =
      b.role ??
      (recognizedOptOut ? 'OPT_OUT' : recognizedOptIn ? 'OPT_IN' : undefined);

    if (role === undefined) {
      problems.push(
        `Botão ${b.position} ("${text}"): ninguém declarou o que este botão significa, e o sistema não reconhece o rótulo nem como aceite nem como recusa. Se ele for o "sim" de um opt-in, TODOS os cliques iriam para o lixo em silêncio. Classifique os botões deste template (ou recrie-o pelo orgamind, escolhendo o rótulo da lista).`,
      );
      continue;
    }

    if (role === 'OPT_IN') {
      optIns++;
      if (!recognizedOptIn) {
        problems.push(
          `Botão ${b.position} ("${text}"): este rótulo NÃO será reconhecido como aceite — o clique da pessoa iria para o lixo e o consentimento seria perdido em silêncio. Use um dos rótulos reconhecidos: "${OPT_IN_SUGGESTION}".`,
        );
      }
      continue;
    }

    if (role === 'OPT_OUT') {
      optOuts++;
      if (!recognizedOptOut) {
        problems.push(
          `Botão ${b.position} ("${text}"): este rótulo NÃO será reconhecido como recusa — o contato clicaria em "não" e continuaria recebendo. Use um dos rótulos reconhecidos: "${OPT_OUT_SUGGESTION}".`,
        );
      }
      continue;
    }

    // NONE — o reconhecimento é agnóstico de template: um botão COMUM cujo
    // rótulo cai na lista fechada grava consentimento (ou suprime) por acidente.
    if (recognizedOptOut) {
      problems.push(
        `Botão ${b.position} ("${text}"): este rótulo silencia o contato ao ser clicado (o sistema o lê como recusa e suprime os envios). Reescreva o rótulo ou marque o botão como recusa.`,
      );
    } else if (recognizedOptIn) {
      problems.push(
        `Botão ${b.position} ("${text}"): este rótulo é interpretado como consentimento — um clique aqui gravaria um aceite que a pessoa não deu. Reescreva o rótulo ou marque o botão como opt-in.`,
      );
    }
  }

  if (optIns > 1) {
    problems.push(
      'Um template pode ter no máximo um botão de opt-in (dois aceites tornariam o registro ambíguo).',
    );
  }
  if (optOuts > 1) {
    problems.push('Um template pode ter no máximo um botão de recusa.');
  }
  // Pedir aceite sem oferecer a recusa não é só falta de educação: numa campanha
  // eleitoral, é a diferença entre um opt-in defensável e um funil forçado.
  if (optIns > 0 && optOuts === 0) {
    problems.push(
      'Um template de opt-in precisa oferecer também o botão de recusa (opt-out) — sem a saída, o aceite não é livre.',
    );
  }

  return problems;
}

/**
 * Audita um template ZERNIO **do jeito que ele está no banco**: os rótulos vêm
 * dos `components` (o que a Meta guardou, que é o que volta no clique) e os
 * papéis vêm da declaração persistida. Um rótulo que a Meta mudou perde a
 * declaração — e volta a ser "não declarado", que bloqueia. É o que impede uma
 * row aprovada e utilizável de colher zero.
 */
export function auditZernioTemplateRow(args: {
  components: unknown;
  consentButtonRoles: unknown;
}): string[] {
  const labels = extractQuickReplyLabels(args.components);
  if (labels.length === 0) return [];
  const declared = readDeclaredConsentButtons(args.consentButtonRoles);
  const byLabel = new Map(declared.map((d) => [squashButton(d.text), d.role]));
  return auditConsentButtons(
    labels.map((text, i) => ({
      position: i + 1,
      text,
      role: byLabel.get(squashButton(text)),
    })),
  );
}

/**
 * Mantém a declaração do operador ALINHADA com os rótulos que a Meta reporta.
 * Rótulo que sobreviveu mantém o papel; rótulo que sumiu (ou que a Meta
 * reescreveu) perde — e volta a "não declarado", que o gate bloqueia. Nunca
 * INVENTA papel: um botão novo entra sem declaração, de propósito.
 */
export function reconcileConsentButtonRoles(
  declared: DeclaredConsentButton[],
  currentLabels: string[],
): DeclaredConsentButton[] {
  const byLabel = new Map(declared.map((d) => [squashButton(d.text), d.role]));
  const out: DeclaredConsentButton[] = [];
  for (const text of currentLabels) {
    const role = byLabel.get(squashButton(text));
    if (role) out.push({ text, role });
  }
  return out;
}

export const CONSENT_BUTTON_CHOICES = {
  optIn: [
    'Sim, quero receber', // o rótulo canônico da campanha de reapresentação
    'Sim, aceito receber',
    'Quero receber',
    'Quero receber mensagens',
    'Quero receber novidades',
    'Aceito receber',
    'Aceito receber mensagens',
    'Autorizo o recebimento',
    'Yes, subscribe',
  ],
  optOut: [
    'Não quero receber', // o par canônico do "Sim, quero receber"
    'Não receber',
    'Parar promoções',
    'Sair da lista',
    'Descadastrar',
    'Cancelar',
    'Parar',
  ],
} as const;

export type ConsentButtonChoices = typeof CONSENT_BUTTON_CHOICES;

/**
 * Os rótulos que o operador PODE usar, para CITAR na mensagem de erro. Avaliados
 * na primeira chamada de `auditConsentButtons` (que roda muito depois deste
 * módulo carregar), então a ordem de declaração aqui é indiferente.
 */
const OPT_IN_SUGGESTION = CONSENT_BUTTON_CHOICES.optIn.join('", "');
const OPT_OUT_SUGGESTION = CONSENT_BUTTON_CHOICES.optOut.join('", "');
