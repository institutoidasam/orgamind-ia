/**
 * A QUOTA DO CANAL, CONTADA UMA VEZ SÓ.
 *
 * A causa (c) do "sempre repete": o "500" que o cliente via não era um limite
 * da campanha — era o teto diário do canal (`Channel.dailySendLimit`, mais a
 * rampa de aquecimento nos 5 primeiros dias). A campanha parava em 500 e
 * retomava SOZINHA no reset, mas a tela da campanha não dizia isso: a quota só
 * aparecia na página Canais. O operador concluía que precisava agir, criava
 * outra campanha, e caía na armadilha do "Limitar aos primeiros".
 *
 * Todos os números vêm de `GET /whatsapp/providers` (T15 — todo provedor, não
 * só EVOLUTION; ver resolve-channel.ts), que já os calcula com o
 * `warmup.helper` do backend — a ÚNICA fonte de verdade da quota. Este módulo
 * não recalcula regra nenhuma: ele só compõe, formata e escreve em PT-BR.
 */

/**
 * O recorte de canal que estas funções precisam — subconjunto estrutural de
 * `ChannelSummary` (features/whatsapp/api.ts, T15) e de `Instance`
 * (features/whatsapp/schemas.ts). Declarado aqui de propósito: a Fase A lê a
 * feature de canais, mas não depende do arquivo dela.
 *
 * T15 — `dailySendLimit`/`sentToday` viraram OPCIONAIS aqui porque
 * `ChannelSummary` os declara opcionais no CONTRATO (compatibilidade com
 * cliente antigo), embora o service sempre os preencha. `sentTodayResetAt`
 * aceita `null` pelo mesmo motivo — o backend pode declarar `null`. Ausente
 * ou nulo é tratado como "0"/"sem reset conhecido", nunca como erro.
 */
export type CanalDeEnvio = {
  dailySendLimit?: number;
  sentToday?: number;
  warmupEffectiveCap?: number;
  warming?: boolean;
  warmupDay?: number;
  sentTodayResetAt?: string | null;
};

const DIA_MS = 24 * 60 * 60 * 1000;

/** O teto que vale HOJE: a rampa de aquecimento quando ela está abaixo do configurado. */
export function capDeHoje(canal: CanalDeEnvio): number {
  return canal.warming === true && canal.warmupEffectiveCap != null
    ? canal.warmupEffectiveCap
    : (canal.dailySendLimit ?? 0);
}

/**
 * O PRÓXIMO reset (`sentTodayResetAt + 24h`), sem checar se já passou.
 * `null` quando o backend não informou um `sentTodayResetAt` válido.
 */
function proximoReset(sentTodayResetAt: string | null | undefined): Date | null {
  if (!sentTodayResetAt) return null;
  const ultimo = new Date(sentTodayResetAt);
  if (Number.isNaN(ultimo.getTime())) return null;
  return new Date(ultimo.getTime() + DIA_MS);
}

/**
 * ★ Achado 4 (review final) — `Channel.sentToday` só é zerado pelo WORKER no
 * PRÓXIMO ENVIO (`send-message.processor.ts`, reset condicional na hora de
 * enviar: `resetAge > DAY_MS`). Uma campanha PARADA (sem lote desde ontem)
 * nunca aciona esse reset — `sentToday` no banco fica "velho" indefinidamente
 * até a próxima mensagem sair de verdade. Esta função espelha a MESMA regra
 * do lado da EXIBIÇÃO (não escreve no banco, só decide o que a tela mostra):
 * se o reset já devia ter acontecido, o contador é tratado como 0 aqui —
 * nunca como um "teto de ontem" ainda esgotado.
 */
function resetJaPassou(sentTodayResetAt: string | null | undefined, now: Date): boolean {
  const proximo = proximoReset(sentTodayResetAt);
  return proximo != null && proximo.getTime() <= now.getTime();
}

/** `sentToday` como a TELA deve lê-lo — 0 quando o reset já devia ter acontecido. */
function sentTodayEfetivo(canal: CanalDeEnvio, now: Date): number {
  return resetJaPassou(canal.sentTodayResetAt, now) ? 0 : (canal.sentToday ?? 0);
}

/**
 * Quanto ainda cabe hoje. Nunca negativo — um canal estourado tem 0, não -200.
 *
 * `now` é OBRIGATÓRIO (não um `new Date()` implícito): a tela precisa do
 * MESMO instante para decidir "o reset já passou?" em toda a linha do canal —
 * um default escondido tornaria o resultado dependente de QUANDO a função é
 * chamada, e os testes, do relógio real da máquina.
 */
export function quotaRestante(canal: CanalDeEnvio, now: Date): number {
  return Math.max(0, capDeHoje(canal) - sentTodayEfetivo(canal, now));
}

/**
 * A hora em que o teto reinicia, NO FUSO DA CAMPANHA.
 *
 * O contador zera 24h depois do último reset. O fuso é o da campanha
 * (`Campaign.timezone`, default America/Manaus) e não o do navegador: o
 * operador está em Manaus e o servidor em UTC — dizer "reinicia às 13:00"
 * para quem vive às 09:00 é pior do que não dizer nada.
 *
 * `null` quando o backend não informou UM reset, OU quando o reset devido já
 * PASSOU (achado 4) — a tela não pode anunciar uma hora do passado como se
 * fosse o próximo reset; `fraseDoCanal` troca por "assim que o próximo envio
 * sair" nesse segundo caso.
 */
export function horaDoReset(
  sentTodayResetAt: string | null | undefined,
  timezone: string,
  now: Date,
): string | null {
  const proximo = proximoReset(sentTodayResetAt);
  if (!proximo || proximo.getTime() <= now.getTime()) return null;
  const opcoes: Intl.DateTimeFormatOptions = {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  };
  try {
    return proximo.toLocaleTimeString('pt-BR', { ...opcoes, timeZone: timezone });
  } catch {
    // Fuso inválido gravado na campanha: melhor a hora local do que quebrar a tela.
    return proximo.toLocaleTimeString('pt-BR', opcoes);
  }
}

/**
 * Quantos o campo "Enviar agora" propõe.
 *
 * ★ NUNCA 0 QUANDO AINDA HÁ GENTE. Se a quota de hoje já acabou, o campo parte
 * do teto diário INTEIRO e o aviso explica que o lote fica em fila — um campo
 * zerado leria como "não dá para enviar" e mandaria o operador procurar o
 * problema em outro lugar, que é exatamente o que já aconteceu.
 */
export function tamanhoInicialDoLote(args: {
  restam: number;
  quotaRestante: number;
  capDeHoje: number;
}): number {
  if (args.restam <= 0) return 0;
  // Minor 10 (review final) — `capDeHoje === 0` é um canal SEM teto
  // configurado (nenhuma quota, nunca), não uma sobra de arredondamento. O
  // piso `Math.max(1, …)` abaixo existe para NÃO propor 0 quando ainda cabe
  // gente hoje — mas com capDeHoje 0 não cabe NINGUÉM hoje, e propor "1"
  // oferece um lote que o canal não tem como cumprir.
  if (args.capDeHoje === 0 && args.quotaRestante === 0) return 0;
  const base = args.quotaRestante > 0 ? args.quotaRestante : args.capDeHoje;
  return Math.max(1, Math.min(base, args.restam));
}

/**
 * O aviso ao lado do campo — nunca um bloqueio.
 *
 * Passar do teto é PERMITIDO: o worker adia o excedente (`moveToDelayed`) e ele
 * sai sozinho no reset. Bloquear aqui seria inventar uma regra que o sistema
 * não tem, e esconder do operador que ele PODE enfileirar a noite inteira.
 */
export function avisoDeQuota(args: {
  tamanho: number;
  quotaRestante: number;
  reset: string | null;
}): string | null {
  const quando = args.reset
    ? `a partir de ${args.reset}`
    : 'quando o teto reiniciar';
  if (args.quotaRestante <= 0) {
    return `O teto de hoje deste canal acabou: este lote fica em fila e sai ${quando}.`;
  }
  if (args.tamanho > args.quotaRestante) {
    const excedente = args.tamanho - args.quotaRestante;
    return `Acima do teto de hoje: ${excedente} ficam em fila e saem ${quando}.`;
  }
  return null;
}

/**
 * A linha do canal no cabeçalho de progresso, em PT-BR e numa frase só.
 *
 * `now` (achado 4, review final): a mesma injeção de relógio de
 * `quotaRestante`/`horaDoReset`, para o número de "enviou X de Y hoje" e o
 * "teto reinicia às…" nunca discordarem um do outro na mesma frase.
 */
export function fraseDoCanal(args: {
  nome: string;
  canal: CanalDeEnvio;
  timezone: string;
  now: Date;
}): string {
  const cap = capDeHoje(args.canal);
  const enviouHoje = sentTodayEfetivo(args.canal, args.now);
  const partes = [`Canal ${args.nome}: enviou ${enviouHoje} de ${cap} hoje`];
  if (args.canal.warming === true && args.canal.warmupDay != null) {
    partes.push(`aquecimento: dia ${args.canal.warmupDay}, teto ${cap}`);
  }
  const reset = horaDoReset(args.canal.sentTodayResetAt, args.timezone, args.now);
  if (reset) {
    partes.push(`teto reinicia às ${reset}`);
  } else if (resetJaPassou(args.canal.sentTodayResetAt, args.now)) {
    // O reset já devia ter acontecido, mas só o PRÓXIMO envio de verdade o
    // executa (o worker zera na hora de enviar, não num cron) — dizer "assim
    // que o próximo envio sair" é mais honesto do que uma hora do passado.
    partes.push('teto reinicia assim que o próximo envio sair');
  }
  return partes.join(' · ');
}
