import { Prisma, PrismaClient } from '@prisma/client';
import { brazilianPhoneVariants } from '../src/modules/contacts/phone.util';
import { refreshConversationSummary } from './backfill-conversations';

const prisma = new PrismaClient();

/**
 * REPARO DE DADOS (idempotente) — as DUPLICATAS que o bug do 9º dígito criou.
 *
 * `brazilianPhoneVariants` só reconhecia a forma legada de 8 dígitos quando ela
 * começava com 9, então todo celular `9 8…`, `9 7…`, `9 6…` ficava sem variante.
 * Quando essas pessoas RESPONDERAM ao broadcast, o WhatsApp reportou o inbound na
 * forma legada, o `chat-ingest` não achou o contato da planilha e CRIOU UM NOVO,
 * com o nome de perfil do WhatsApp. Resultado em produção: ~20 pessoas viraram
 * dois contatos — o da planilha (9 díg., com cidade/grupo/whatsappValid) e o do
 * ingest (8 díg., carregando a CONVERSA e as MENSAGENS da resposta dela).
 *
 * O contato do ingest NÃO é lixo: é onde estão as respostas à campanha. Este
 * script não apaga nada antes de MIGRAR — e a ordem importa, porque
 * `Message.contactId` é `onDelete: Cascade`: apagar o duplicado sem repontar as
 * mensagens antes as apagaria junto (o ativo mais valioso do cliente).
 *
 *   npx tsx prisma/merge-duplicate-phone-contacts.ts            # dry-run (padrão)
 *   npx tsx prisma/merge-duplicate-phone-contacts.ts --apply    # para valer
 *
 * QUEM SOBREVIVE NÃO É "O DE 9 DÍGITOS". É QUEM ENTREGA.
 *
 * Esta é a única decisão irreversível do script: uma das duas linhas é APAGADA.
 * Eleger pelo FORMATO parece óbvio e é perigoso — o incidente de produção deste
 * projeto ([[picoa-9o-digito-entrega]]) mediu o A/B no MESMO número e deu o
 * contrário do senso comum: a forma de 13 dígitos parou em `Sent` para sempre; a
 * de 12 chegou a `Delivered` em 15 segundos. O WhatsApp aceita a stanza da
 * grafia errada e a DESCARTA CALADO, sem erro em lugar nenhum. E só o adapter do
 * GoZap resolve o número canônico antes de enviar: Zernio, Evolution, Twilio e
 * Meta mandam exatamente a string que está gravada no Contact.
 *
 * Fundir tudo para a grafia de 13 dígitos poderia, portanto, converter "a pessoa
 * recebe duas vezes" em "a pessoa não recebe nunca" — e apagar justamente a
 * linha que funcionava. Por isso a eleição olha a EVIDÊNCIA, nesta ordem:
 *
 *   1. ENTREGA CONFIRMADA — mensagem OUTBOUND em DELIVERED/READ. É a prova
 *      direta de que o WhatsApp entregou NAQUELA grafia.
 *   2. RESPOSTA RECEBIDA — mensagem INBOUND. O provedor endereça a pessoa por
 *      esse JID e a thread é real.
 *   3. VALIDAÇÃO DO WHATSAPP — `whatsappValid`: `true` vence `null`, que vence
 *      `false` (um `false` medido é evidência NEGATIVA daquela string).
 *   4. FORMATO — só quando as duas linhas são igualmente mudas: aí vence a de 13
 *      dígitos, a mesma que `canonicalBrPhoneForm` elege para as leituras.
 *
 * O relatório diz, par a par, QUAL critério decidiu e com quais números — é o que
 * um humano lê no log do deploy antes/depois de a linha sumir.
 *
 * O QUE MUDOU (auditoria C5/C6): o script só fundia o par quando o de 8 dígitos
 * NÃO tinha procedência de planilha (cidade, grupo, whatsappValid, ImportItem) —
 * com ela, classificava como AMBÍGUO e não tocava. Só que esse é EXATAMENTE o par
 * que o import defeituoso vinha criando: as duas grafias da mesma pessoa,
 * ambas vindas de planilha. Por isso a base continuava suja apesar de o reparo
 * rodar a cada deploy.
 *
 * Dois registros que são variante um do outro são, por definição do WhatsApp, o
 * MESMO assinante — não existem duas pessoas com o mesmo número. A fusão passou
 * a valer para esses pares também, PRESERVANDO DADO: campo vazio no sobrevivente
 * é preenchido a partir do gêmeo (nome, cidade, grupo, tags); campo preenchido no
 * sobrevivente NUNCA é sobrescrito. Quando os dois trazem valores diferentes para
 * o mesmo campo, o sobrevivente vence e o par é REPORTADO em `conflicts`, para
 * conferência humana depois — sem deixar de fundir, porque manter dois
 * destinatários do mesmo WhatsApp é o dano maior.
 *
 * `whatsappValid` é a EXCEÇÃO e nunca é copiado: ele é a medida de uma STRING,
 * não de uma pessoa. Copiar o `true` do gêmeo para o sobrevivente fabricaria um
 * resultado de validação para uma grafia que nunca foi validada — exatamente o
 * dado com que o script decide quem morre.
 *
 * O que continua fora do alcance da regra: números que NÃO são variante um do
 * outro. Um fixo (`+559232145678`) nunca vira par de um celular fabricado —
 * `brazilianPhoneVariants` exige [6-9] no miolo justamente por isso, e um falso
 * positivo aqui fundiria DUAS PESSOAS DIFERENTES.
 *
 * CONSENTIMENTO: não movemos `ContactConsent` na mão. Ele é um cache derivado do
 * `ConsentEvent`, que é append-only (trigger no banco), sobrevive à exclusão do
 * contato e é chaveado por `phoneHash` — e, com o bug corrigido,
 * `phoneHashVariants` agora cobre AS DUAS formas. Então mandamos o próprio
 * `ConsentService.rehydrate` recompor o estado do canônico a partir da trilha,
 * o que aplica a precedência real do §2.7 (occurredAt → recordedAt → REVOKE
 * vence) e atualiza `optedOut` a partir da SuppressionList. Mover as linhas na
 * mão poderia RESSUSCITAR um opt-out: se o sobrevivente tem GRANT da planilha e o
 * gêmeo tem o REVOKE de um "PARAR", quem manda é a trilha, não a linha.
 * A reidratação roda ANTES do delete, e o delete SÓ ACONTECE SE ELA DER CERTO —
 * senão o par sobra inteiro para a próxima execução, que é o que o "idempotente"
 * do título promete.
 */

/** Recompõe ContactConsent + caches do canônico a partir da trilha do phoneHash. */
export type Rehydrate = (contactId: string, phoneE164: string) => Promise<unknown>;

type ContactRow = {
  id: string;
  phoneE164: string;
  name: string | null;
  city: string | null;
  group: string | null;
  tags: string[];
  whatsappValid: boolean | null;
  optedOut: boolean;
  createdAt: Date;
};

/**
 * Par fundido em que os DOIS traziam valor para o mesmo campo. O SOBREVIVENTE
 * venceu (nunca sobrescrevemos dado existente dele); isto é o rastro para
 * conferência humana depois — não um motivo para não fundir.
 */
export type ConflictingPair = {
  /** O telefone que FICOU (não necessariamente o de 13 dígitos — ver `elect`). */
  canonicalPhone: string;
  /** O telefone que foi APAGADO. */
  duplicatePhone: string;
  fields: string[];
};

/**
 * QUAL CRITÉRIO DECIDIU quem sobrevive. Vai para o log do deploy porque a decisão
 * é irreversível e um humano precisa poder discordar dela DEPOIS.
 */
export type ElectionCriterion =
  /** Uma das linhas tem OUTBOUND em DELIVERED/READ e a outra não. */
  | 'entrega_confirmada'
  /** Empate na entrega; uma das linhas tem INBOUND (a pessoa respondeu nela). */
  | 'resposta_recebida'
  /** Empate nas mensagens; decide `whatsappValid` (true > null > false). */
  | 'validacao_whatsapp'
  /** As duas linhas são mudas: desempata o formato (13 díg. vence). */
  | 'formato';

/** O que o script FEZ com um par — a linha do relatório que precede um delete. */
export type MergedPair = {
  survivorPhone: string;
  deletedPhone: string;
  /** Os `Contact.id` — é por eles que um humano confere no banco sem o telefone. */
  survivorId: string;
  deletedId: string;
  criterion: ElectionCriterion;
  /** Os números crus que sustentaram a decisão, para conferência humana. */
  detail: string;
};

/**
 * Par que ESTOUROU. O laço registra e SEGUE — um par doente não pode sequestrar
 * os outros 27 (era o que acontecia: o `throw` subia e a varredura morria no
 * primeiro par, para sempre, em todo deploy).
 */
export type FailedPair = {
  survivorPhone: string;
  deletedPhone: string;
  survivorId: string;
  deletedId: string;
  /** Código do Prisma quando houver (P2002 etc.) — é o que se procura no log. */
  code: string | null;
  message: string;
};

export type MergeReport = {
  apply: boolean;
  /** Pares (9 díg. ↔ 8 díg.) encontrados na base. */
  pairs: number;
  /** Pares efetivamente fundidos. */
  merged: number;
  /** Um registro por par: quem sobreviveu, quem morreu e POR QUÊ. */
  merges: MergedPair[];
  /** Pares fundidos com divergência de campo — o sobrevivente venceu. */
  conflicts: ConflictingPair[];
  messagesMoved: number;
  /** Conversas do duplicado repontadas para o canônico (o canônico não tinha uma no canal). */
  conversationsMoved: number;
  /** Conversas fundidas numa só (canônico e duplicado tinham conversa no MESMO canal). */
  conversationsFolded: number;
  importItemsMoved: number;
  /** Canônicos cuja reidratação de consentimento falhou (o merge foi feito; rode o rehydrate de novo). */
  rehydrateFailures: string[];
  /**
   * Linhas VIVAS neutralizadas para caber na trava de banco "uma linha viva por
   * (campanha, contato)" — a mesma régua do PASSO 1 da migration, aplicada agora
   * ao par de contatos que está sendo fundido. Nada é apagado.
   */
  liveRowsNeutralized: number;
  /** Pares que estouraram e foram PULADOS (o laço continua). */
  failedPairs: FailedPair[];
};

/**
 * ★ A MESMA RÉGUA DA MIGRATION — copiada de propósito, e comentada para não divergir.
 *
 * `20260819010000_message_one_live_row_per_campaign_contact/migration.sql`
 * (PASSO 1) escolhe, entre linhas vivas do MESMO par (campanha, contato), quem
 * fica: a MAIS AVANÇADA no funil, desempatando pela MAIS ANTIGA. As demais viram
 * `CANCELLED` com `errorCode = 'duplicate_row_neutralized'`.
 *
 * Aqui a régua vale para um par de CONTATOS que está prestes a virar UM contato.
 * Se as duas grafias da mesma pessoa entraram na mesma campanha, cada uma tem a
 * sua linha viva; no instante em que `Message.contactId` é repontado, as duas
 * passam a ser a mesma chave e o índice recusa (P2002). Não dá para a migration
 * resolver isso: ela roda ANTES e particiona por `contactId`, então enxerga dois
 * contatos distintos e nada de errado. Quem cria a colisão é o repontamento —
 * então é o repontamento que tem de desfazê-la, com a MESMA regra, para que o
 * estado final seja idêntico ao de fundir antes de migrar.
 */
const LIVE_STATUSES = [
  'QUEUED',
  'WAITING_INSTANCE',
  'SENDING',
  'SENT',
  'DELIVERED',
  'READ',
] as const;

/** READ > DELIVERED > SENT > SENDING > QUEUED > WAITING_INSTANCE (menor = fica). */
const FUNNEL_RANK: Record<string, number> = {
  READ: 1,
  DELIVERED: 2,
  SENT: 3,
  SENDING: 4,
  QUEUED: 5,
  WAITING_INSTANCE: 6,
};

/**
 * A tabela de SOCORRO que torna a neutralização REVERSÍVEL.
 *
 * `status` anterior não sobrevive ao UPDATE, e `QUEUED` e `WAITING_INSTANCE` são
 * INDISTINGUÍVEIS depois do fato (os dois só têm `queuedAt`). O `errorCode`
 * anterior também é sobrescrito — e o F2 preserva `errorCode`/`errorMessage` de
 * propósito numa linha que voltou para QUEUED, como prova da tentativa anterior.
 * Guardar as quatro colunas antes de escrever custa uma tabela minúscula e
 * transforma "irreversível" em `UPDATE ... FROM`. Criada pela migration; o script
 * de fusão grava aqui com `source = 'merge'`.
 */
const NEUTRALIZED_BACKUP_TABLE = '_message_dup_neutralized_20260819';

const NEUTRALIZED_ERROR_CODE = 'duplicate_row_neutralized';

/**
 * O telefone do eleitor NÃO vai inteiro para o log do deploy.
 *
 * Este script roda com `--apply` em todo deploy e o stdout do contêiner `migrate`
 * é exatamente o que a API do Dokploy expõe (é o mesmo motivo por que o pacote
 * segurança tirou o segredo do webhook do log). Numa campanha eleitoral, telefone
 * de eleitor é dado pessoal com finalidade político-partidária. O que um humano
 * precisa para conferir no banco é o `Contact.id`, que o relatório imprime junto
 * — o número inteiro só sai com `--verbose`, que o docker-compose não usa.
 */
export function maskPhonesInLog(text: string): string {
  // +55 DD + 8 (grafia legada) ou 9 (moderna) dígitos: some com o miolo e sobram
  // o DDD e os 4 últimos — o bastante para um humano reconhecer o caso, pouco
  // demais para identificar alguém a partir do log.
  return text.replace(
    /\+55(\d{2})(\d{4,5})(\d{4})/g,
    (_m, ddd: string, _meio: string, fim: string) => `+55${ddd}*****${fim}`,
  );
}

/**
 * A forma LEGADA (8 díg.) de um celular moderno (9 díg.), ou null se o número
 * não for um celular moderno. Deriva de `brazilianPhoneVariants` — uma única
 * definição da regra do 9º dígito para o app inteiro e para este reparo.
 */
function legacyFormOf(phoneE164: string): string | null {
  const digits = phoneE164.replace(/^\+55(\d{2})/, '');
  if (digits.length !== 9) return null;
  const alt = brazilianPhoneVariants(phoneE164).find((v) => v !== phoneE164);
  return alt ?? null;
}

/**
 * O `data` da atualização do sobrevivente: só o que ele NÃO TEM, vindo do gêmeo.
 *
 * A regra é uma só — preencher vazio, nunca sobrescrever.
 *
 * `whatsappValid` NÃO SEGUE ESSA REGRA e nunca é copiado: ele descreve a STRING
 * medida, não a pessoa. O gêmeo é justamente a OUTRA grafia; herdar o `true` dele
 * fabricaria um resultado de validação para um número que nunca foi validado — e
 * é com esse campo que a eleição decide quem morre. Divergência entre os dois
 * lados vira `conflict` (é informação: as duas grafias mediram diferente).
 *
 * O caso que pede ação é o inverso: o sobrevivente ganhou por TRÁFEGO REAL
 * (`wonByRealTraffic` — entrega confirmada ou resposta recebida) e ainda carrega
 * `whatsappValid: false`. O `false` está desmentido pelos fatos, e mantê-lo
 * tiraria a pessoa dos segmentos e dos relatórios de alcançabilidade. Nesse caso
 * zeramos a MEDIÇÃO (`null` + `whatsappCheckedAt: null`) para o cron
 * `stale`/`unvalidated` rechecar a grafia que de fato ficou — zerar é honesto,
 * inventar `true` não seria.
 *
 * `optedOut` anda no sentido contrário: `true` de qualquer lado vence. ATENÇÃO ao
 * que essa linha É e ao que ela NÃO É — a garantia de que uma revogação nunca se
 * perde na fusão é da SuppressionList (`@id phoneHash`, sem FK com Contact,
 * consultada por `phoneHashVariants`, que hoje cobre as DUAS grafias): ela
 * sobrevive ao delete do gêmeo por conta própria. `Contact.optedOut` é só cache
 * derivado, e o `rehydrate` que roda logo depois o REESCREVE a partir da
 * SuppressionList (`refreshContactCache`), desfazendo este write quando o titular
 * tem trilha de consentimento. Este write é a rede para o único caso em que o
 * rehydrate não fala: quando não há `ConsentEvent` nenhum e ele retorna cedo.
 *
 * Devolve também os campos em que os dois tinham valor e discordavam.
 */
function mergeFields(
  survivor: ContactRow,
  loser: ContactRow,
  wonByRealTraffic: boolean,
): { data: Prisma.ContactUpdateInput; conflicts: string[] } {
  const data: Prisma.ContactUpdateInput = {};
  const conflicts: string[] = [];

  const textFields = ['name', 'city', 'group'] as const;
  for (const f of textFields) {
    const mine = survivor[f];
    const theirs = loser[f];
    if (!theirs) continue;
    if (!mine) data[f] = theirs;
    else if (mine !== theirs) conflicts.push(f);
  }

  if (
    loser.whatsappValid !== null &&
    survivor.whatsappValid !== null &&
    survivor.whatsappValid !== loser.whatsappValid
  ) {
    conflicts.push('whatsappValid');
  }

  if (survivor.whatsappValid === false && wonByRealTraffic) {
    data.whatsappValid = null;
    data.whatsappCheckedAt = null;
  }

  if (loser.optedOut === true && survivor.optedOut !== true) {
    data.optedOut = true;
  }

  data.tags = [...new Set([...survivor.tags, ...loser.tags])];

  return { data, conflicts };
}

/**
 * A prova de que o WhatsApp fala com ESTA grafia. Contada no banco, por contato:
 * é o que separa "o número certo" de "o número bonito".
 */
type DeliveryEvidence = {
  /** OUTBOUND que o WhatsApp confirmou (DELIVERED/READ). Prova direta. */
  delivered: number;
  /** INBOUND: o provedor endereça a pessoa por este JID e ela respondeu. */
  inbound: number;
  whatsappValid: boolean | null;
};

async function collectEvidence(
  db: PrismaClient,
  row: ContactRow,
): Promise<DeliveryEvidence> {
  // SENT NÃO CONTA. Foi exatamente o status em que as mensagens do incidente do
  // 9º dígito ficaram presas para sempre: o WhatsApp aceitou e descartou.
  const delivered = await db.message.count({
    where: {
      contactId: row.id,
      direction: 'OUTBOUND',
      status: { in: ['DELIVERED', 'READ'] },
    },
  });
  const inbound = await db.message.count({
    where: { contactId: row.id, direction: 'INBOUND' },
  });
  return { delivered, inbound, whatsappValid: row.whatsappValid };
}

/** true > null > false — `false` é evidência NEGATIVA, não ausência de dado. */
function validityRank(v: boolean | null): number {
  return v === true ? 1 : v === false ? -1 : 0;
}

/**
 * QUEM FICA. A ordem é a da confiança: entrega confirmada, resposta recebida,
 * validação do WhatsApp e — só entre duas linhas igualmente mudas — o formato.
 */
function elect(
  nine: ContactRow,
  nineEv: DeliveryEvidence,
  eight: ContactRow,
  eightEv: DeliveryEvidence,
): {
  survivor: ContactRow;
  loser: ContactRow;
  criterion: ElectionCriterion;
  detail: string;
  wonByRealTraffic: boolean;
} {
  const pick = (
    winnerIsNine: boolean,
    criterion: ElectionCriterion,
    detail: string,
    wonByRealTraffic: boolean,
  ) => ({
    survivor: winnerIsNine ? nine : eight,
    loser: winnerIsNine ? eight : nine,
    criterion,
    detail,
    wonByRealTraffic,
  });

  if (nineEv.delivered > 0 !== eightEv.delivered > 0) {
    return pick(
      nineEv.delivered > 0,
      'entrega_confirmada',
      `DELIVERED/READ ${nine.phoneE164}=${nineEv.delivered} × ${eight.phoneE164}=${eightEv.delivered}`,
      true,
    );
  }

  if (nineEv.inbound > 0 !== eightEv.inbound > 0) {
    return pick(
      nineEv.inbound > 0,
      'resposta_recebida',
      `INBOUND ${nine.phoneE164}=${nineEv.inbound} × ${eight.phoneE164}=${eightEv.inbound}`,
      true,
    );
  }

  const nineRank = validityRank(nineEv.whatsappValid);
  const eightRank = validityRank(eightEv.whatsappValid);
  if (nineRank !== eightRank) {
    return pick(
      nineRank > eightRank,
      'validacao_whatsapp',
      `whatsappValid ${nine.phoneE164}=${String(nineEv.whatsappValid)} × ${eight.phoneE164}=${String(eightEv.whatsappValid)}`,
      false,
    );
  }

  return pick(
    true,
    'formato',
    'nenhuma evidência de entrega dos dois lados — desempate pelo formato (13 díg.)',
    false,
  );
}

export async function mergeDuplicatePhoneContacts(
  db: PrismaClient = prisma,
  opts: { apply?: boolean; rehydrate?: Rehydrate } = {},
): Promise<MergeReport> {
  const apply = opts.apply === true;
  const report: MergeReport = {
    apply,
    pairs: 0,
    merged: 0,
    merges: [],
    conflicts: [],
    messagesMoved: 0,
    conversationsMoved: 0,
    conversationsFolded: 0,
    importItemsMoved: 0,
    rehydrateFailures: [],
    liveRowsNeutralized: 0,
    failedPairs: [],
  };

  const contacts = (await db.contact.findMany({
    select: {
      id: true,
      phoneE164: true,
      name: true,
      city: true,
      group: true,
      tags: true,
      whatsappValid: true,
      optedOut: true,
      createdAt: true,
    },
  })) as ContactRow[];

  const byPhone = new Map<string, ContactRow>();
  for (const c of contacts) byPhone.set(c.phoneE164, c);

  for (const nine of contacts) {
    // Só o de 9 dígitos INICIA um par — assim cada par é visitado uma vez só e a
    // varredura não depende da ordem. Quem SOBREVIVE ao par, porém, não é
    // decidido aqui: quem decide é `elect`, olhando a evidência de entrega.
    const legacy = legacyFormOf(nine.phoneE164);
    if (!legacy) continue;
    const eight = byPhone.get(legacy);
    if (!eight) continue;

    report.pairs += 1;

    const nineEv = await collectEvidence(db, nine);
    const eightEv = await collectEvidence(db, eight);
    const { survivor, loser, criterion, detail, wonByRealTraffic } = elect(
      nine,
      nineEv,
      eight,
      eightEv,
    );

    // ★ UM PAR RUIM NÃO SEQUESTRA OS OUTROS 27.
    //
    // Antes, qualquer erro dentro de `mergePair` subia e matava a varredura
    // inteira — e, como o par problemático continua na base, o deploy seguinte
    // morria no MESMO lugar, para sempre. Agora a falha vira uma linha do
    // relatório (e código de saída != 0 no fim) e o laço segue.
    try {
      // ★ OU O PAR É FUNDIDO INTEIRO, OU NÃO É TOCADO.
      //
      // `mergePair` escrevia FORA de transação: quando estourava no meio, o que
      // já tinha sido escrito FICAVA — conversa apagada, mensagem pendurada na
      // thread de outro contato, contatos não fundidos. Uma transação interativa
      // por par elimina a classe inteira. `timeout` alto porque o par pode
      // arrastar milhares de mensagens num VPS lento; `maxWait` idem.
      const moved = apply
        ? await db.$transaction(
            (tx) => mergePair(tx, survivor, loser, true, wonByRealTraffic),
            { timeout: 120_000, maxWait: 30_000 },
          )
        : await mergePair(db, survivor, loser, false, wonByRealTraffic);

      if (moved.conflicts.length > 0) {
        report.conflicts.push({
          canonicalPhone: survivor.phoneE164,
          duplicatePhone: loser.phoneE164,
          fields: moved.conflicts,
        });
      }
      report.messagesMoved += moved.messages;
      report.conversationsMoved += moved.conversationsMoved;
      report.conversationsFolded += moved.conversationsFolded;
      report.importItemsMoved += moved.importItems;
      report.liveRowsNeutralized += moved.liveRowsNeutralized;
      report.merged += 1;
      report.merges.push({
        survivorPhone: survivor.phoneE164,
        deletedPhone: loser.phoneE164,
        survivorId: survivor.id,
        deletedId: loser.id,
        criterion,
        detail,
      });

      if (!apply) continue;

      // A trilha (ConsentEvent) é durável e chaveada por phoneHash: com o bug
      // corrigido, o sobrevivente enxerga também os eventos gravados sob a outra
      // grafia. Reidratar ANTES do delete — e, se falhar, NÃO APAGAR. Apagar assim
      // mesmo tornaria o par invisível para sempre: o sobrevivente ficaria sem as
      // finalidades que só o gêmeo tinha e ninguém mais reencontraria o par.
      if (opts.rehydrate) {
        try {
          await opts.rehydrate(survivor.id, survivor.phoneE164);
        } catch {
          report.rehydrateFailures.push(survivor.phoneE164);
          continue;
        }
      }

      // Só agora. ContactConsent do gêmeo cai por cascade (é cache derivado);
      // Message/Conversation/ImportItem já saíram de cima dele.
      await db.contact.delete({ where: { id: loser.id } });
    } catch (e) {
      report.failedPairs.push({
        survivorPhone: survivor.phoneE164,
        deletedPhone: loser.phoneE164,
        survivorId: survivor.id,
        deletedId: loser.id,
        code: (e as { code?: string }).code ?? null,
        message: (e as Error).message?.split('\n').filter(Boolean).slice(-1)[0] ?? String(e),
      });
    }
  }

  return report;
}

/**
 * O cliente dentro da transação do par. `PrismaClient` é atribuível a ele, então
 * o dry-run continua podendo passar o cliente normal.
 */
type Db = Prisma.TransactionClient;

/**
 * ★ O CONSERTO DO BLOQUEANTE: desfazer a colisão ANTES de criá-la.
 *
 * Situação real (provada contra Postgres): a Joana está na base como dois
 * `Contact` (as duas grafias do 9º dígito), os DOIS entraram na mesma campanha e
 * cada um tem a sua `Message` viva. O PASSO 1 da migration não enxerga isso —
 * ele particiona por (campaignId, contactId) e ali são dois contatos diferentes.
 * No instante em que o merge reaponta `Message.contactId` do perdedor para o
 * sobrevivente, o par (campanha, contato) passa a existir DUAS vezes em estado
 * vivo e o índice único parcial recusa com P2002.
 *
 * A regra aplicada aqui é, letra por letra, a do PASSO 1: por campanha, sobrevive
 * a linha MAIS AVANÇADA no funil (READ > DELIVERED > SENT > SENDING > QUEUED >
 * WAITING_INSTANCE), desempatando pela MAIS ANTIGA (createdAt asc, id asc). As
 * demais viram `CANCELLED` com `errorCode = 'duplicate_row_neutralized'`. NADA é
 * apagado: `sentAt`/`deliveredAt`/`providerMessageId` continuam ali como prova de
 * entrega, e o estado anterior vai para a tabela de socorro para que a
 * neutralização seja REVERSÍVEL (`status` não sobrevive ao UPDATE, e QUEUED e
 * WAITING_INSTANCE seriam indistinguíveis depois do fato).
 *
 * O resultado é bit a bit o mesmo de fundir os contatos ANTES da migration.
 */
async function neutralizeLiveCollisions(
  db: Db,
  survivor: ContactRow,
  loser: ContactRow,
  apply: boolean,
): Promise<number> {
  const live = await db.message.findMany({
    where: {
      contactId: { in: [survivor.id, loser.id] },
      direction: 'OUTBOUND',
      campaignId: { not: null },
      status: { in: [...LIVE_STATUSES] },
    },
    select: {
      id: true,
      campaignId: true,
      status: true,
      createdAt: true,
      errorCode: true,
      errorMessage: true,
    },
    orderBy: { id: 'asc' },
  });

  // Agrupa por campanha: DEPOIS do repontamento todas essas linhas serão do
  // mesmo contato, então cada campanha só pode terminar com UMA linha viva.
  const byCampaign = new Map<string, typeof live>();
  for (const m of live) {
    if (!m.campaignId) continue;
    const bucket = byCampaign.get(m.campaignId);
    if (bucket) bucket.push(m);
    else byCampaign.set(m.campaignId, [m]);
  }

  const doomed: typeof live = [];
  for (const rows of byCampaign.values()) {
    if (rows.length < 2) continue;
    const ordered = [...rows].sort((a, b) => {
      const rank = (FUNNEL_RANK[a.status] ?? 7) - (FUNNEL_RANK[b.status] ?? 7);
      if (rank !== 0) return rank;
      const age = a.createdAt.getTime() - b.createdAt.getTime();
      if (age !== 0) return age;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    doomed.push(...ordered.slice(1));
  }

  if (doomed.length === 0 || !apply) return doomed.length;

  // O SOCORRO primeiro: guardar o que o UPDATE vai sobrescrever. Se a tabela não
  // existir (banco anterior à migration), não travamos o reparo por causa dela.
  for (const m of doomed) {
    try {
      await db.$executeRaw`
        INSERT INTO "_message_dup_neutralized_20260819"
          ("id", "status", "errorCode", "errorMessage", "source")
        VALUES (${m.id}, ${m.status}::text, ${m.errorCode}, ${m.errorMessage}, 'merge')
        ON CONFLICT ("id") DO NOTHING`;
    } catch {
      // sem tabela de socorro, seguimos — a alternativa (não fundir) é pior.
    }
  }

  await db.message.updateMany({
    where: { id: { in: doomed.map((m) => m.id) } },
    data: {
      status: 'CANCELLED',
      errorCode: NEUTRALIZED_ERROR_CODE,
      errorMessage: `Linha duplicada do mesmo titular nesta campanha: as duas grafias do 9º dígito eram a MESMA pessoa e foram fundidas num contato só. Sobreviveu a linha mais avançada no funil. Nada foi apagado: sentAt/deliveredAt/providerMessageId continuam aqui. O estado anterior (status/errorCode/errorMessage) está em "${NEUTRALIZED_BACKUP_TABLE}", source='merge'.`,
    },
  });

  return doomed.length;
}

async function mergePair(
  db: Db,
  survivor: ContactRow,
  loser: ContactRow,
  apply: boolean,
  wonByRealTraffic: boolean,
): Promise<{
  messages: number;
  conversationsMoved: number;
  conversationsFolded: number;
  importItems: number;
  conflicts: string[];
  liveRowsNeutralized: number;
}> {
  const dupConversations = await db.conversation.findMany({
    where: { contactId: loser.id },
    select: { id: true, instanceId: true, lastMessageAt: true, createdAt: true },
  });
  const messages = await db.message.count({ where: { contactId: loser.id } });
  const importItems = await db.importItem.count({
    where: { contactId: loser.id },
  });

  // ★ A COLISÃO É RESOLVIDA ANTES DO REPONTAMENTO, E O REPONTAMENTO VEM ANTES
  //   DE QUALQUER DESTRUIÇÃO.
  //
  // Duas mudanças de ORDEM, ambas deliberadas:
  //  (1) neutralizar as linhas vivas que vão colidir ANTES do `updateMany` do
  //      `contactId` — é o que impede o P2002 do índice único parcial;
  //  (2) fazer o repontamento (o passo que o banco pode RECUSAR) ANTES de fundir
  //      e APAGAR conversas. Mesmo com a transação em volta, é defesa em
  //      profundidade: o passo perigoso acontece enquanto nada foi destruído.
  const liveRowsNeutralized = await neutralizeLiveCollisions(
    db,
    survivor,
    loser,
    apply,
  );

  if (apply) {
    // ⚠️ ANTES de qualquer delete de contato: Message.contactId é onDelete: Cascade.
    await db.message.updateMany({
      where: { contactId: loser.id },
      data: { contactId: survivor.id },
    });
    await db.importItem.updateMany({
      where: { contactId: loser.id },
      data: { contactId: survivor.id },
    });
  }

  let conversationsMoved = 0;
  let conversationsFolded = 0;
  const touched = new Set<string>();

  for (const dupConv of dupConversations) {
    // A conversa do canônico NO MESMO CANAL — é com ela que a do duplicado
    // colide (as duas são da mesma pessoa, no mesmo canal, em threads separadas:
    // o disparo caiu numa e a resposta dela na outra).
    const canonConv = await db.conversation.findFirst({
      where: { contactId: survivor.id, instanceId: dupConv.instanceId },
      select: { id: true, lastMessageAt: true, createdAt: true },
    });

    if (!canonConv) {
      conversationsMoved += 1;
      if (apply) {
        await db.conversation.update({
          where: { id: dupConv.id },
          data: { contactId: survivor.id },
        });
      }
      continue;
    }

    // FUSÃO. Quem SOBREVIVE é a conversa MAIS ATIVA — a mesma regra de desempate
    // do `resolveConversationForOutbound` ("a mais ativa vence").
    //
    // E não é preciosismo: o `chat-ingest` dá upsert da conversa na chave
    // [instanceId, remoteJid] com o remoteJid QUE O PROVEDOR REPORTA. Para essas
    // pessoas o provedor reporta a forma legada de 8 dígitos — que é justamente a
    // conversa do duplicado. Se fundíssemos "para dentro" da conversa do canônico
    // e apagássemos a do duplicado, a PRÓXIMA resposta dela recriaria a conversa
    // de 8 dígitos e a thread se partiria de novo. Manter a mais ativa (que é a
    // que tem o inbound dela) deixa o reparo estável.
    const convSurvivor = moreActive(dupConv, canonConv) ? dupConv : canonConv;
    const convLoser = convSurvivor.id === dupConv.id ? canonConv : dupConv;
    conversationsFolded += 1;

    if (apply) {
      // Mover as mensagens ANTES de apagar a perdedora:
      // `Message.conversationId` é onDelete: Cascade.
      await db.message.updateMany({
        where: { conversationId: convLoser.id },
        data: { conversationId: convSurvivor.id },
      });
      await db.conversation.update({
        where: { id: convSurvivor.id },
        data: { contactId: survivor.id },
      });
      await db.conversation.delete({ where: { id: convLoser.id } });
      touched.add(convSurvivor.id);
    }
  }

  // PRESERVAR DADO é a razão de a fusão ser segura: nada que só o gêmeo tinha
  // pode desaparecer com ele. Calculado sempre (o dry-run também reporta os
  // conflitos), aplicado só com --apply.
  const { data, conflicts } = mergeFields(survivor, loser, wonByRealTraffic);

  if (apply) {
    await db.contact.update({
      where: { id: survivor.id },
      data,
    });

    for (const conversationId of touched) {
      // O resumo é derivado e só lê/reescreve a própria Conversation — roda
      // dentro da mesma transação do par para que o preview nunca fique
      // descrevendo uma fusão que não commitou.
      await refreshConversationSummary(db as unknown as PrismaClient, conversationId);
    }
  }

  return {
    messages,
    conversationsMoved,
    conversationsFolded,
    importItems,
    conflicts,
    liveRowsNeutralized,
  };
}

/** "a mais ativa vence": lastMessageAt desc (nulls last), empate → createdAt asc. */
function moreActive(
  a: { lastMessageAt: Date | null; createdAt: Date },
  b: { lastMessageAt: Date | null; createdAt: Date },
): boolean {
  if (a.lastMessageAt && b.lastMessageAt) {
    if (a.lastMessageAt.getTime() !== b.lastMessageAt.getTime()) {
      return a.lastMessageAt > b.lastMessageAt;
    }
    return a.createdAt < b.createdAt;
  }
  if (a.lastMessageAt) return true;
  if (b.lastMessageAt) return false;
  return a.createdAt < b.createdAt;
}

/**
 * O reidratador real, ligado no ConsentService. Exige o SAL: reidratar com o sal
 * errado procuraria hashes que não existem e silenciosamente zeraria o
 * consentimento do canônico — por isso falha alto em vez de assumir ''.
 */
async function realRehydrate(db: PrismaClient): Promise<Rehydrate> {
  const salt = process.env.PICOA_CONSENT_SALT;
  if (!salt) {
    throw new Error(
      'PICOA_CONSENT_SALT ausente: sem o sal, a reidratação do consentimento procuraria hashes errados e apagaria o consentimento do canônico. Rode com o mesmo sal do app.',
    );
  }
  const { ConsentService } = await import('../src/modules/consent/consent.service');
  const service = new ConsentService(
    db as never,
    { get: () => salt } as never,
  );
  return (contactId, phoneE164) => service.rehydrate(contactId, phoneE164);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const apply = process.argv.includes('--apply');
  // `--verbose` (ou MERGE_LOG_FULL_PHONES=1) imprime o telefone INTEIRO. O
  // docker-compose NÃO usa nenhum dos dois: no deploy o log sai mascarado.
  const verbose =
    process.argv.includes('--verbose') || process.env.MERGE_LOG_FULL_PHONES === '1';
  /** Toda linha do relatório passa por aqui — nenhuma escapa por esquecimento. */
  const say = (line: string) => console.log(verbose ? line : maskPhonesInLog(line));

  (async () => {
    // VÁLVULA DE ESCAPE, documentada no OPERATIONS.md. O merge é FATAL no
    // docker-compose (script que APAGA linha de contato não pode falhar em
    // silêncio), e um par cronicamente doente travaria todo deploy seguinte.
    // Esta env, ligada no painel do Dokploy, destrava a subida sem editar o
    // compose — e diz em voz alta que o reparo NÃO rodou.
    if (process.env.MERGE_DUPLICATE_CONTACTS === 'skip') {
      console.log(
        '⏭️  MERGE_DUPLICATE_CONTACTS=skip — o reparo de contatos duplicados NÃO rodou neste deploy. Enquanto isso ficar ligado, gêmeos do 9º dígito continuam recebendo a mesma campanha DUAS VEZES. Desligue assim que o par problemático for resolvido.',
      );
      return;
    }

    const rehydrate = apply ? await realRehydrate(prisma) : undefined;
    const r = await mergeDuplicatePhoneContacts(prisma, { apply, rehydrate });

    console.log(
      apply
        ? '=== MERGE APLICADO ==='
        : '=== DRY-RUN (nada foi escrito; use --apply para valer) ===',
    );
    console.log(`pares encontrados .......... ${r.pairs}`);
    console.log(`fundidos ................... ${r.merged}`);
    console.log(`com campo divergente ....... ${r.conflicts.length}`);
    console.log(`mensagens migradas ......... ${r.messagesMoved}`);
    console.log(`conversas repontadas ....... ${r.conversationsMoved}`);
    console.log(`conversas fundidas ......... ${r.conversationsFolded}`);
    console.log(`ImportItems repontados ..... ${r.importItemsMoved}`);
    console.log(`linhas vivas neutralizadas . ${r.liveRowsNeutralized}`);
    console.log(`pares que FALHARAM ......... ${r.failedPairs.length}`);

    // QUEM MORREU E POR QUÊ. Uma linha por par, porque o delete é irreversível e
    // o log do deploy é a única chance de um humano discordar da eleição.
    // O telefone sai MASCARADO; o `Contact.id` vai junto porque é com ele que se
    // confere no banco sem expor dado de eleitor no log do deploy.
    const porCriterio = new Map<ElectionCriterion, number>();
    for (const m of r.merges) {
      porCriterio.set(m.criterion, (porCriterio.get(m.criterion) ?? 0) + 1);
    }
    console.log('--- quem sobreviveu, e por qual critério ---');
    for (const [criterio, n] of porCriterio) {
      console.log(`  ${criterio} ......... ${n}`);
    }
    for (const m of r.merges) {
      say(
        `  ${apply ? 'FUNDIDO' : 'FUNDIRIA'} ${m.survivorPhone} [${m.survivorId}] (fica) ← ${m.deletedPhone} [${m.deletedId}] (some) | ${m.criterion}: ${m.detail}`,
      );
    }
    const semEvidencia = r.merges.filter((m) => m.criterion === 'formato').length;
    if (semEvidencia > 0) {
      console.log(
        `⚠️  ${semEvidencia} par(es) sem NENHUMA evidência de entrega dos dois lados — decididos só pelo formato. Se algum deles for de uma pessoa que você sabe que responde, confira a grafia ANTES do --apply.`,
      );
    }

    for (const c of r.conflicts) {
      say(
        `  DIVERGÊNCIA ${c.canonicalPhone} ↔ ${c.duplicatePhone}: ${c.fields.join(', ')} — o sobrevivente foi mantido; confira se o valor do gêmeo era o certo`,
      );
    }
    if (r.liveRowsNeutralized > 0) {
      console.log(
        `ℹ️  ${r.liveRowsNeutralized} linha(s) viva(s) do mesmo titular na mesma campanha foram neutralizadas (CANCELLED / ${NEUTRALIZED_ERROR_CODE}) para caber na trava "uma linha viva por (campanha, contato)". Nada foi apagado e o estado anterior está em "${NEUTRALIZED_BACKUP_TABLE}" (source='merge').`,
      );
    }
    if (r.rehydrateFailures.length > 0) {
      say(
        `⚠️  reidratação do consentimento FALHOU em ${r.rehydrateFailures.length}: ${r.rehydrateFailures.join(', ')} — o gêmeo NÃO foi apagado nesses pares; a próxima execução refaz`,
      );
    }

    // ★ FALHA DE PAR NÃO PODE PASSAR DESPERCEBIDA.
    //
    // O laço agora SEGUE depois de um par ruim — o que é certo (um par doente
    // não pode paralisar o reparo dos outros 27), mas cria o risco oposto: sair
    // 0 com dano por consertar. Por isso a saída é != 0 quando algum par falhou,
    // e o docker-compose encadeia este script com `&&`: o job `migrate` fica
    // VERMELHO, api/worker não são recriados e prod continua no código anterior.
    if (r.failedPairs.length > 0) {
      console.error(
        `\n❌ ${r.failedPairs.length} PAR(ES) NÃO FORAM FUNDIDOS — o reparo não terminou. Essas pessoas continuam como DOIS contatos e podem receber a mesma campanha duas vezes:`,
      );
      for (const f of r.failedPairs) {
        console.error(
          maskPhonesInLog(
            `   ${f.survivorPhone} [${f.survivorId}] ← ${f.deletedPhone} [${f.deletedId}] :: ${f.code ?? 'sem código'} — ${f.message}`,
          ),
        );
      }
      console.error(
        'Nenhum desses pares foi tocado (cada par roda numa transação própria). Veja "Reparo de contatos duplicados falhou" no OPERATIONS.md.',
      );
      process.exitCode = 1;
    }
  })()
    .catch((e) => {
      console.error(e);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
}
