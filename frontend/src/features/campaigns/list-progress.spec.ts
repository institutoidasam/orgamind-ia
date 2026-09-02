import { describe, it, expect } from 'vitest';
import { contagemDaLinha, textoDaLinha, statusDoOperador } from './list-progress';
import type { CampaignSummary } from './schemas';

const campanha = (over: Partial<CampaignSummary> = {}): CampaignSummary => ({
  id: 'c1',
  name: 'Campanha',
  templateId: 'tpl1',
  totalRecipients: 13400,
  status: 'RUNNING',
  createdAt: new Date('2026-08-24T00:00:00Z'),
  statusCounts: [
    { status: 'SENT', _count: 300 },
    { status: 'DELIVERED', _count: 150 },
    { status: 'READ', _count: 50 },
  ],
  ...over,
});

/**
 * A.6 — A LINHA DA LISTA TEM DE RESPONDER "QUANTO FALTA" SEM CONSULTAR
 * AUDIÊNCIA. Tudo sai de `totalRecipients` (que agora é o público elegível
 * vivo) e das contagens por status que a listagem já traz.
 */
describe('progresso da linha', () => {
  it('soma SENT+DELIVERED+READ como "já receberam"', () => {
    expect(contagemDaLinha(campanha())).toEqual({
      sent: 500,
      total: 13400,
      restam: 12900,
    });
  });

  it('escreve "500 / 13.400 · restam 12.900"', () => {
    expect(textoDaLinha(campanha())).toBe('500 / 13.400 · restam 12.900');
  });

  it('nunca mostra "restam" negativo', () => {
    expect(contagemDaLinha(campanha({ totalRecipients: 100 })).restam).toBe(0);
  });
});

describe('status escrito para o operador', () => {
  it('em andamento com lote disponível', () => {
    expect(statusDoOperador({ campaign: campanha(), quotaRestante: 380 })).toBe(
      'Em andamento — próximo lote disponível',
    );
  });

  it('aguardando o teto quando a quota de hoje acabou', () => {
    expect(
      statusDoOperador({ campaign: campanha(), quotaRestante: 0, reset: '09:00' }),
    ).toBe('Aguardando teto (reinicia 09:00)');
  });

  /**
   * "Aguardando canal" tem prioridade sobre o teto: mensagem parada porque o
   * número caiu não volta sozinha no reset — alguém tem de reconectar.
   */
  it('aguardando canal quando há mensagem esperando a conexão', () => {
    const c = campanha({
      statusCounts: [
        { status: 'SENT', _count: 300 },
        { status: 'WAITING_INSTANCE', _count: 81 },
      ],
    });
    expect(statusDoOperador({ campaign: c, quotaRestante: 0, reset: '09:00' })).toBe(
      'Aguardando canal',
    );
  });

  it('concluída e cancelada falam por si', () => {
    expect(
      statusDoOperador({ campaign: campanha({ status: 'COMPLETED' }) }),
    ).toBe('Concluída');
    expect(
      statusDoOperador({ campaign: campanha({ status: 'CANCELLED' }) }),
    ).toBe('Cancelada');
  });

  /**
   * Fix round 1 (review) — sem `reset`, "Aguardando teto (reinicia undefined)"
   * seria pior que não dizer a hora. `horaDoReset` já devolve `null` quando o
   * backend não informou o reset (canal sem `sentTodayResetAt`); este é o
   * ramo que cobre esse caso.
   */
  it('aguardando o teto sem hora de reset conhecida', () => {
    expect(
      statusDoOperador({ campaign: campanha(), quotaRestante: 0, reset: null }),
    ).toBe('Aguardando teto do canal');
  });
});

/**
 * Fix round 1 (review, achado Importante) — QUEUED é uma campanha que ainda
 * NÃO começou a disparar (agendada para o futuro, ou parada na fila). Antes
 * deste ramo ela caía direto no "Em andamento — próximo lote disponível" do
 * caminho genérico, que é falso: não existe lote nenhum em curso.
 */
describe('status escrito para o operador — QUEUED (agendada/na fila)', () => {
  it('ONCE_AT mostra data e hora do disparo, no fuso da campanha', () => {
    const c = campanha({
      status: 'QUEUED',
      statusCounts: [],
      scheduleType: 'ONCE_AT',
      nextRunAt: '2026-08-26T13:00:00.000Z', // 09:00 em America/Manaus (UTC-4)
      timezone: 'America/Manaus',
    });
    expect(statusDoOperador({ campaign: c })).toBe('Agendada — 26/08 09:00');
  });

  it('DAILY_AT (recorrente) mostra só a hora da próxima rodada', () => {
    const c = campanha({
      status: 'QUEUED',
      statusCounts: [],
      scheduleType: 'DAILY_AT',
      nextRunAt: '2026-08-26T13:00:00.000Z',
      timezone: 'America/Manaus',
    });
    expect(statusDoOperador({ campaign: c })).toBe('Recorrente — próxima 09:00');
  });

  /**
   * Minor 12 (review final) — o ramo ONCE_AT (via `formatarDataHora`) já
   * tinha try/catch para um fuso inválido gravado na campanha; o ramo
   * recorrente formatava a hora inline, sem a mesma proteção. Um fuso ruim
   * não pode quebrar a linha inteira da lista — só perder a conversão.
   */
  it('DAILY_AT com fuso inválido não quebra — cai na hora local, como o irmão ONCE_AT', () => {
    const c = campanha({
      status: 'QUEUED',
      statusCounts: [],
      scheduleType: 'DAILY_AT',
      nextRunAt: '2026-08-26T13:00:00.000Z',
      timezone: 'Fuso/Que/Nao/Existe',
    });
    expect(() => statusDoOperador({ campaign: c })).not.toThrow();
    expect(statusDoOperador({ campaign: c })).toMatch(/^Recorrente — próxima \d{2}:\d{2}$/);
  });

  it('sem informação de agendamento (nextRunAt ausente), mostra "Na fila" — nunca "Em andamento"', () => {
    const c = campanha({
      status: 'QUEUED',
      statusCounts: [],
      scheduleType: undefined,
      nextRunAt: undefined,
    });
    expect(statusDoOperador({ campaign: c, quotaRestante: 380 })).toBe('Na fila');
  });
});

/**
 * ★ Achado 3(a) (Importante, review final) — `create()` deixa a linha em
 * DRAFT; `QUEUED` só existe por microssegundos (o tick a consome na hora). Uma
 * campanha AGENDADA (A.3 — "Continuar automaticamente", ou um `ONCE_AT`
 * futuro) passa a maior parte da vida em DRAFT com `nextRunAt`+
 * `scheduleEnabled` já gravados — e o ramo `Agendada — …`/`Recorrente — …` de
 * `textoAgendamento` (só alcançado hoje via `c.status === 'QUEUED'`) nunca
 * era atingido. A lista mostrava "Rascunho — nada foi enviado ainda", que é
 * tecnicamente verdade mas esconde que a campanha VAI disparar sozinha.
 */
describe('status escrito para o operador — DRAFT agendado (achado 3a)', () => {
  it('DRAFT com nextRunAt+scheduleEnabled (ONCE_AT) mostra "Agendada — …", não "Rascunho"', () => {
    const c = campanha({
      status: 'DRAFT',
      statusCounts: [],
      scheduleType: 'ONCE_AT',
      scheduleEnabled: true,
      nextRunAt: '2026-08-26T13:00:00.000Z', // 09:00 em America/Manaus (UTC-4)
      timezone: 'America/Manaus',
    });
    expect(statusDoOperador({ campaign: c })).toBe('Agendada — 26/08 09:00');
  });

  it('DRAFT com nextRunAt+scheduleEnabled (DAILY_AT) mostra "Recorrente — …"', () => {
    const c = campanha({
      status: 'DRAFT',
      statusCounts: [],
      scheduleType: 'DAILY_AT',
      scheduleEnabled: true,
      nextRunAt: '2026-08-26T13:00:00.000Z',
      timezone: 'America/Manaus',
    });
    expect(statusDoOperador({ campaign: c })).toBe('Recorrente — próxima 09:00');
  });

  it('DRAFT com scheduleEnabled:false (agendamento desligado) continua "Rascunho"', () => {
    const c = campanha({
      status: 'DRAFT',
      statusCounts: [],
      scheduleType: 'ONCE_AT',
      scheduleEnabled: false,
      nextRunAt: '2026-08-26T13:00:00.000Z',
    });
    expect(statusDoOperador({ campaign: c })).toBe('Rascunho — nada foi enviado ainda');
  });

  it('DRAFT sem nextRunAt (o caso comum: nunca foi agendada) continua "Rascunho"', () => {
    const c = campanha({ status: 'DRAFT', statusCounts: [] });
    expect(statusDoOperador({ campaign: c })).toBe('Rascunho — nada foi enviado ainda');
  });
});

/**
 * Fix round 1 (review, minor) — linha LEGADA: `totalRecipients` zerado (ou
 * ausente) mas já com `sent` > 0. "500 / 0 · restam 0" leria como campanha
 * vazia já concluída — quando na verdade ela despachou 500 mensagens.
 */
describe('linha legada — totalRecipients zerado com sent > 0', () => {
  it('mostra "500 enviadas" em vez de "500 / 0 · restam 0"', () => {
    const c = campanha({ totalRecipients: 0, statusCounts: [{ status: 'SENT', _count: 500 }] });
    expect(textoDaLinha(c)).toBe('500 enviadas');
  });

  it('totalRecipients ausente (undefined) tem o mesmo tratamento que 0', () => {
    const c = campanha({
      totalRecipients: undefined as unknown as number,
      statusCounts: [{ status: 'DELIVERED', _count: 12 }],
    });
    expect(textoDaLinha(c)).toBe('12 enviadas');
  });
});
