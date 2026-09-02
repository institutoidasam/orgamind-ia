import { describe, it, expect } from 'vitest';
import {
  capDeHoje,
  quotaRestante,
  horaDoReset,
  tamanhoInicialDoLote,
  avisoDeQuota,
  fraseDoCanal,
} from './channel-quota';

/**
 * A CAUSA (c) DO "SEMPRE REPETE": o "500" que o cliente via não era um limite
 * da campanha — era o TETO DIÁRIO do canal. A campanha parava e retomava
 * sozinha no reset, mas a tela não dizia isso, e ele criava outra campanha.
 * Estes números são a explicação, então eles têm de estar certos.
 */
describe('quota do canal', () => {
  const canal = {
    dailySendLimit: 500,
    sentToday: 120,
    sentTodayResetAt: '2026-08-24T13:00:00.000Z',
  };
  // "Agora" de referência para os testes que não são sobre o relógio em si:
  // 2h depois do último reset — bem dentro das 24h, nunca "stale".
  const AGORA = new Date('2026-08-24T15:00:00.000Z');

  it('sem aquecimento, o teto de hoje é o limite configurado', () => {
    expect(capDeHoje(canal)).toBe(500);
    expect(quotaRestante(canal, AGORA)).toBe(380);
  });

  it('em aquecimento, o teto de hoje é o da rampa', () => {
    const aquecendo = { ...canal, warming: true, warmupEffectiveCap: 50, warmupDay: 2 };
    expect(capDeHoje(aquecendo)).toBe(50);
    expect(quotaRestante(aquecendo, AGORA)).toBe(0);
  });

  it('quota nunca é negativa', () => {
    expect(quotaRestante({ dailySendLimit: 500, sentToday: 700 }, AGORA)).toBe(0);
  });

  it('o reset é 24h depois do último, no fuso da campanha', () => {
    // 2026-08-24T13:00Z + 24h = 2026-08-25T13:00Z = 09:00 em Manaus (UTC-4).
    expect(horaDoReset(canal.sentTodayResetAt, 'America/Manaus', AGORA)).toBe('09:00');
  });

  it('sem reset conhecido, devolve null (a tela não inventa um horário)', () => {
    expect(horaDoReset(undefined, 'America/Manaus', AGORA)).toBeNull();
  });

  // T15 — `ChannelSummary.sentTodayResetAt` (backend) declara `string | null`;
  // `null` tem de ser tratado igual a "sem reset conhecido", não estourar.
  it('sentTodayResetAt nulo também devolve null (não é só ausente)', () => {
    expect(horaDoReset(null, 'America/Manaus', AGORA)).toBeNull();
  });

  // T15 — dailySendLimit/sentToday viraram opcionais no contrato
  // (ChannelSummary); ausentes têm de virar "0", nunca "undefined"/NaN.
  it('sem dailySendLimit/sentToday (contrato antigo), o teto e a quota são 0', () => {
    expect(capDeHoje({})).toBe(0);
    expect(quotaRestante({}, AGORA)).toBe(0);
  });

  it('o tamanho inicial é o menor entre a quota restante e o que resta do público', () => {
    expect(
      tamanhoInicialDoLote({ restam: 12900, quotaRestante: 380, capDeHoje: 500 }),
    ).toBe(380);
    expect(
      tamanhoInicialDoLote({ restam: 40, quotaRestante: 380, capDeHoje: 500 }),
    ).toBe(40);
  });

  /**
   * ★ O CAMPO NUNCA NASCE COM 0. Quota zerada é a hora em que o operador MAIS
   * precisa de um número — senão ele conclui que o sistema travou.
   */
  it('com a quota de hoje esgotada, parte do teto diário inteiro', () => {
    expect(
      tamanhoInicialDoLote({ restam: 12900, quotaRestante: 0, capDeHoje: 500 }),
    ).toBe(500);
  });

  it('sem ninguém restando, o tamanho é 0', () => {
    expect(
      tamanhoInicialDoLote({ restam: 0, quotaRestante: 380, capDeHoje: 500 }),
    ).toBe(0);
  });

  /**
   * Minor 10 (review final) — `capDeHoje === 0` é um canal SEM teto
   * configurado (nunca tem quota nenhuma), não "1 vaga sobrando por
   * arredondamento". `Math.max(1, ...)` devolvia 1 mesmo aqui, e o campo
   * nascia com "1" propondo enviar para um canal que não tem NENHUMA
   * capacidade — o piso "nunca 0 quando há gente" só faz sentido quando o
   * canal TEM algum teto.
   */
  it('canal sem teto configurado (capDeHoje 0 e quotaRestante 0) propõe 0, não 1', () => {
    expect(
      tamanhoInicialDoLote({ restam: 12900, quotaRestante: 0, capDeHoje: 0 }),
    ).toBe(0);
  });

  it('avisa que o teto acabou, sem bloquear', () => {
    expect(avisoDeQuota({ tamanho: 500, quotaRestante: 0, reset: '09:00' })).toBe(
      'O teto de hoje deste canal acabou: este lote fica em fila e sai a partir de 09:00.',
    );
  });

  it('avisa o excedente quando o número pedido passa do teto', () => {
    expect(
      avisoDeQuota({ tamanho: 500, quotaRestante: 380, reset: '09:00' }),
    ).toBe('Acima do teto de hoje: 120 ficam em fila e saem a partir de 09:00.');
  });

  it('dentro do teto, não avisa nada', () => {
    expect(avisoDeQuota({ tamanho: 300, quotaRestante: 380, reset: '09:00' })).toBeNull();
  });

  it('a linha do canal diz quanto já saiu e quando o teto reinicia', () => {
    expect(
      fraseDoCanal({ nome: 'robo', canal, timezone: 'America/Manaus', now: AGORA }),
    ).toBe('Canal robo: enviou 120 de 500 hoje · teto reinicia às 09:00');
  });

  it('em aquecimento, a linha do canal diz o dia e o teto da rampa', () => {
    const aquecendo = {
      ...canal,
      sentToday: 50,
      warming: true,
      warmupEffectiveCap: 50,
      warmupDay: 2,
    };
    expect(
      fraseDoCanal({
        nome: 'robo',
        canal: aquecendo,
        timezone: 'America/Manaus',
        now: AGORA,
      }),
    ).toBe(
      'Canal robo: enviou 50 de 50 hoje · aquecimento: dia 2, teto 50 · teto reinicia às 09:00',
    );
  });
});

/**
 * ★ Achado 4 (Importante, review final) — `Channel.sentToday` só é zerado
 * pelo WORKER no PRÓXIMO envio (`send-message.processor.ts:638-646`, reset
 * condicional na hora de enviar). Uma campanha parada (sem lote novo desde
 * ontem) nunca aciona esse reset — `sentToday`/`sentTodayResetAt` no banco
 * ficam "velhos" indefinidamente até a PRÓXIMA mensagem realmente sair. Sem
 * espelhar a mesma regra de 24h no front, a tela dizia "o teto de hoje
 * acabou" com um reset que já devia ter acontecido HÁ HORAS — o "hoje" da
 * tela virava o "ontem" do canal.
 *
 * `now` é injetado (não `new Date()` implícito) porque as datas fixas destes
 * testes são de 2026-08-24 — um `new Date()` de verdade quebraria sozinho
 * assim que o relógio da máquina passasse de 2026-08-25T13:00Z.
 */
describe('quota com reset velho (achado 4 — "hoje" do canal parado é "ontem")', () => {
  const canal = {
    dailySendLimit: 500,
    sentToday: 500, // esgotado — segundo o contador que ninguém zerou
    sentTodayResetAt: '2026-08-24T13:00:00.000Z', // próximo reset: 2026-08-25T13:00Z
  };
  // 25h depois do último reset — já passou da hora do PRÓXIMO reset, mas o
  // worker não zerou porque não houve mensagem nova (campanha parada).
  const RESET_JA_PASSOU = new Date('2026-08-25T14:00:00.000Z');
  // 2h ANTES do próximo reset — ainda dentro das 24h, sentToday é de hoje mesmo.
  const AINDA_DENTRO_DE_24H = new Date('2026-08-25T11:00:00.000Z');

  it('com o reset ainda dentro de 24h, sentToday vale como está (quota realmente esgotada)', () => {
    expect(quotaRestante(canal, AINDA_DENTRO_DE_24H)).toBe(0);
  });

  it('com o reset já passado (>=24h), sentToday é tratado como 0 — quota volta a ser o teto inteiro', () => {
    expect(quotaRestante(canal, RESET_JA_PASSOU)).toBe(500);
  });

  it('horaDoReset devolve null quando o reset já passou (não inventa uma hora do passado)', () => {
    expect(horaDoReset(canal.sentTodayResetAt, 'America/Manaus', RESET_JA_PASSOU)).toBeNull();
    // Dentro das 24h, a hora normal continua valendo.
    expect(
      horaDoReset(canal.sentTodayResetAt, 'America/Manaus', AINDA_DENTRO_DE_24H),
    ).toBe('09:00');
  });

  it('exatamente nas 24h (limite) já conta como passado — espelha o `resetAge >= DAY_MS` do processor', () => {
    const noLimite = new Date(
      new Date(canal.sentTodayResetAt).getTime() + 24 * 60 * 60 * 1000,
    );
    expect(quotaRestante(canal, noLimite)).toBe(500);
  });

  it('a linha do canal mostra "enviou 0 de 500" e "assim que o próximo envio sair", não uma hora do passado', () => {
    expect(
      fraseDoCanal({
        nome: 'robo',
        canal,
        timezone: 'America/Manaus',
        now: RESET_JA_PASSOU,
      }),
    ).toBe('Canal robo: enviou 0 de 500 hoje · teto reinicia assim que o próximo envio sair');
  });

  it('a linha do canal continua normal dentro das 24h', () => {
    expect(
      fraseDoCanal({
        nome: 'robo',
        canal,
        timezone: 'America/Manaus',
        now: AINDA_DENTRO_DE_24H,
      }),
    ).toBe('Canal robo: enviou 500 de 500 hoje · teto reinicia às 09:00');
  });
});
