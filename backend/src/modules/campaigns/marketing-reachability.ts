/**
 * ZE — QUEM NUNCA MAIS VAI RECEBER UM TEMPLATE DE MARKETING.
 *
 * Fato medido ao vivo (broadcast real de 120 destinatários): 37 falhas — 30% da
 * base — sendo 36x `131026` e 1x `130472`. Não é um pico transitório: é a
 * fração da base que DESLIGOU mensagens de marketing no WhatsApp. Para essas
 * pessoas, um template de MARKETING não é entregue hoje nem daqui a um mês.
 *
 * Por que isso precisa virar estado no `Contact`, e não só um `Message.status`:
 *   1. **Reenviar é caro.** Cada tentativa consome uma reserva do tier diário
 *      (o cap de usuários únicos em 24h). 30% da base falhando significa 30% da
 *      cota queimada sem entregar nada — e a cota é o recurso escasso do disparo.
 *   2. **Vale para TODAS as campanhas, não só a atual.** O sinal é uma
 *      propriedade do DESTINATÁRIO ("desliguei marketing"), não da campanha. Se
 *      o estado morasse na `Message`, a campanha seguinte recomeçaria do zero e
 *      queimaria a mesma cota de novo.
 *   3. **É definitivo, não transitório.** É exatamente a distinção que o
 *      operador precisa ver na tela: "falhou e pode retentar" ≠ "não adianta
 *      insistir". Confundir as duas faz o operador retentar para sempre.
 *
 * ATENÇÃO ao escopo: isto bloqueia MARKETING, e só. A própria Meta é explícita
 * no 130472 — "UTILITY TEMPLATES ARE NOT AFFECTED". Uma campanha UTILITY (ex.:
 * `servico_projeto`) continua alcançando essas pessoas normalmente, e é por isso
 * que a exclusão do lote é condicionada à categoria do template da campanha.
 *
 * Isto NÃO substitui e NÃO se confunde com o gate de consentimento nem com a
 * SuppressionList: consentimento é a base LEGAL do envio (LGPD); isto aqui é a
 * ENTREGABILIDADE técnica na Meta. Um contato pode ter consentido e ainda assim
 * ser inalcançável para marketing.
 */

/**
 * Códigos da Meta que significam, definitivamente: *este destinatário não
 * recebe template de MARKETING*.
 *
 * - `131026` — "Message undeliverable". A Meta: "the recipient has likely
 *   TURNED OFF MARKETING MESSAGES".
 * - `130472` — "part of a marketing-message experiment, cannot receive
 *   marketing templates right now. UTILITY TEMPLATES ARE NOT AFFECTED."
 *
 * Deliberadamente FORA desta lista:
 * - `131049` (cap diário de marketing do destinatário) — expira em 24h. É
 *   temporário por definição; marcá-lo aqui descartaria o contato para sempre
 *   por um limite que se renova sozinho. Ele já tem o bloqueio de 24h em Redis.
 * - `131047` (fora da janela de 24h) — não é sobre marketing, é sobre precisar
 *   de um template. Um template é justamente o que a campanha manda.
 */
export const MARKETING_UNDELIVERABLE_CODES = ['131026', '130472'] as const;

const MARKETING_UNDELIVERABLE_REASONS: Record<string, string> = {
  '131026':
    'O destinatário desligou as mensagens de marketing no WhatsApp (Meta 131026). ' +
    'Templates UTILITY continuam sendo entregues.',
  '130472':
    'O destinatário está num experimento de mensagens de marketing da Meta e não ' +
    'recebe templates de MARKETING agora (Meta 130472). Templates UTILITY continuam ' +
    'sendo entregues.',
};

/** true → o contato deve ser marcado como inalcançável para MARKETING. */
export function isMarketingUndeliverableCode(
  code: string | null | undefined,
): boolean {
  if (!code) return false;
  return (MARKETING_UNDELIVERABLE_CODES as readonly string[]).includes(code);
}

/**
 * Motivo em PT-BR persistido em `Contact.marketingUndeliverableReason` — é o que
 * o operador lê na tela. Null quando o código não torna o contato inalcançável.
 */
export function marketingUndeliverableReason(
  code: string | null | undefined,
): string | null {
  if (!code) return null;
  return MARKETING_UNDELIVERABLE_REASONS[code] ?? null;
}

/**
 * Falhas DEFINITIVAS do destinatário: um novo lote da MESMA campanha não deve
 * reenviar para quem falhou assim — a falha não vai mudar de resultado.
 *
 * O complemento é a regra que importa: qualquer outra falha (rate limit, 5xx,
 * timeout, erro sem código) é TRANSITÓRIA, e o contato VOLTA a ser pendente no
 * próximo lote. É a diferença entre "a Meta recusou este destinatário" e "o
 * Zernio estava fora do ar" — e é a razão de um lote poder ser simplesmente
 * repetido depois de um incidente, sem o operador ter que caçar quem faltou.
 */
const PERMANENT_RECIPIENT_FAILURE_CODES: readonly string[] = [
  ...MARKETING_UNDELIVERABLE_CODES,
  // Número não é usuário do WhatsApp — nenhuma retentativa conserta.
  '131021',
  // Idem, no vocabulario do GoZap: `IsIn:false` do /chat/check e a recusa do
  // proprio provedor. Sem estar aqui, o contato reentra em TODO lote seguinte,
  // refaz o /chat/check, falha de novo — e o "Reenviar falhas" vira laco.
  'gozap.not_on_whatsapp',
  'gozap.invalid_recipient',
  // Destinatário optou por sair / bloqueou (Meta e Zernio).
  '131050',
  'recipient_opted_out',
  // Telefone inválido no cadastro — é preciso corrigir o contato, não retentar.
  'invalid_field_value',
  // Timeout indeterminado de CLIENTE — TODO provedor, não só a Twilio. A
  // mensagem PODE ter sido entregue e cobrada (o POST pode ter saído sem que
  // soubéssemos); reenviar arrisca cobrança dupla + entrega duplicada (sinal
  // de ban). Nasceu como exclusividade da Twilio; generalizada porque sem
  // isto o send-message.processor terminaliza a Message como FAILED sem
  // reenviar NAQUELE attempt (INDETERMINATE_TIMEOUTS), mas o PRÓXIMO LOTE
  // desta mesma campanha achava o contato pendente de novo e reenviava — a
  // MESMA duplicata, só que via `pendingAudienceWhere`/`isHandledInCampaign`
  // (batch-audience.ts) em vez do retry do BullMQ. O Zernio é o provedor do
  // tráfego REAL do cliente — tinha o MESMO buraco.
  'twilio.indeterminate',
  'zernio.indeterminate',
  'gozap.indeterminate',
  // Os CRUS (`zernio.timeout`/`gozap.timeout`) também entram — deliberado,
  // não redundância. Antes desta correção o `@OnWorkerEvent('failed')`
  // (send-message.processor.ts) gravava o código CRU do adapter quando o
  // BullMQ esgotava as 5 tentativas, porque a guarda B3 só existia para a
  // Twilio: um timeout do Zernio era relançado, retentado, e a linha FINAL
  // ficava com `errorCode: 'zernio.timeout'` — nunca com o terminal
  // `zernio.indeterminate`. Essas linhas LEGADAS existem hoje no banco e
  // carregam o MESMO risco (entrega talvez já ocorrida) que as novas. Omitir
  // o cru trataria só o tráfego NOVO, deixando quem já pode ter recebido até
  // 5x de fora da proteção. `zernio.unreachable` fica de fora de propósito —
  // é falha de REDE (ECONNREFUSED/ENOTFOUND/EAI_AGAIN): a conexão nunca foi
  // estabelecida, o POST nunca chegou ao Zernio, então não há ambiguidade de
  // entrega — retentar continua correto.
  'zernio.timeout',
  'gozap.timeout',
  // C11 (auditoria 2026-08-19) — o worker morreu ENTRE o claim e o markSent
  // (OOM, eviction do container). O `sending-reconciler` grava esta linha como
  // FAILED justamente porque NÃO dá para saber se o provedor aceitou: o POST
  // pode ter saído, sido entregue e cobrado. Ela já bloqueava os BOTÕES de
  // retry (`INDETERMINATE_DELIVERY_CODES`) mas não bloqueava o LOTE — então o
  // lote seguinte da mesma campanha achava o contato pendente e reenviava,
  // pelo caminho automático, a mesma mensagem que talvez já tivesse chegado.
  // Mesmo risco, mesma régua dos `<provider>.indeterminate` acima.
  'sending_stuck',
];

/**
 * Falhas cujo DESFECHO DE ENTREGA é desconhecido: o POST pode ter saído, sido
 * aceito, entregue e cobrado — só não sabemos. Nenhum caminho AUTOMÁTICO pode
 * reenviá-las (nem retry, nem lote, nem redisparo, nem tick).
 *
 * Mora aqui, e não em `campaigns.repository.ts` (de onde é re-exportada por
 * compatibilidade), porque `batch-audience.ts` precisa dela para recortar a
 * audiência e o repositório JÁ importa `batch-audience` — importar de volta
 * fecharia um ciclo. Este módulo não importa ninguém do módulo de campanhas.
 */
export const INDETERMINATE_DELIVERY_CODES = [
  'twilio.indeterminate',
  'sending_stuck',
  'zernio.indeterminate',
  'gozap.indeterminate',
  'zernio.timeout',
  'gozap.timeout',
];

/** true → a falha é definitiva; o contato não volta a ser pendente no lote. */
export function isPermanentRecipientFailure(
  code: string | null | undefined,
): boolean {
  if (!code) return false;
  return PERMANENT_RECIPIENT_FAILURE_CODES.includes(code);
}

export { PERMANENT_RECIPIENT_FAILURE_CODES };
