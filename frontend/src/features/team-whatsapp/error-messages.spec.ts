import { HTTPError } from 'ky';
import { describe, expect, it } from 'vitest';
import {
  apiErrorCode, cancelErrorMessage, channelLabel, countParts, failureReasonLabel, PACING_HINT, recipientStatusLabel,
  retryErrorMessage, SKIP_REASON_LABEL, teamErrorMessage,
} from './error-messages';

describe('teamErrorMessage', () => {
  it.each([
    ['team_whatsapp.forbidden', 'Você não tem permissão para enviar a este destino.'],
    ['team_whatsapp.sector_without_number', 'Há área sem número neste envio. Associe um número a ela em Conexões.'],
    ['team_whatsapp.no_sector', 'Esta pessoa não tem área. Coloque-a num setor antes de enviar.'],
    ['team_whatsapp.channel_disconnected', 'Um número deste envio está desconectado. Veja na prévia qual é.'],
    ['team_whatsapp.channel_unverified', 'Não foi possível conferir o número. Tente de novo'],
    ['team_whatsapp.no_recipients', 'Ninguém neste destino tem telefone válido para receber.'],
    ['team_whatsapp.invalid_selection', 'A lista de pessoas mudou. Atualize a página e confira de novo.'],
    ['team_whatsapp.invalid_level', 'Nível inválido. Atualize a página e tente de novo.'],
    ['team_whatsapp.invalid_shift', 'Este turno não está mais disponível. Atualize a página.'],
    ['team_whatsapp.schedule_in_past', 'O início deste turno já passou. Escolha Enviar agora ou outra data.'],
    ['team_whatsapp.not_cancellable', 'Este envio já saiu ou foi cancelado.'],
    ['team_whatsapp.dispatch_not_found', 'Envio não encontrado. Atualize a página.'],
    ['team_whatsapp.too_many_people', 'Os setores escolhidos têm mais de 2000 pessoas. Escolha menos setores.'],
    [undefined, 'Não foi possível enviar a mensagem.'],
    ['outro.codigo', 'Não foi possível enviar a mensagem.'],
  ])('%s', (code, msg) => expect(teamErrorMessage(code)).toBe(msg));
});

describe('cancelErrorMessage', () => {
  const CANCEL_FALLBACK = 'Não foi possível cancelar o envio. Tente de novo.';
  it.each([
    ['team_whatsapp.not_cancellable', 'Este envio já saiu ou foi cancelado.'],
    ['team_whatsapp.dispatch_not_found', 'Envio não encontrado. Atualize a página.'],
    ['team_whatsapp.too_many_people', 'Os setores escolhidos têm mais de 2000 pessoas. Escolha menos setores.'],
    [undefined, CANCEL_FALLBACK],
    ['outro.codigo', CANCEL_FALLBACK],
  ])('%s', (code, msg) => expect(cancelErrorMessage(code)).toBe(msg));
});

describe('retryErrorMessage', () => {
  const RETRY_FALLBACK = 'Não foi possível repetir o envio. Tente de novo.';
  it.each([
    ['team_whatsapp.forbidden', 'Você não tem permissão para enviar a este destino.'],
    ['team_whatsapp.dispatch_not_found', 'Envio não encontrado. Atualize a página.'],
    [undefined, RETRY_FALLBACK],
    ['outro.codigo', RETRY_FALLBACK],
  ])('%s', (code, msg) => expect(retryErrorMessage(code)).toBe(msg));
});

describe('contagens e número do resultado', () => {
  it('countParts só devolve as situações com gente, na ordem do ciclo', () => {
    const zero = {
      queued: 0, sent: 0, delivered: 0, read: 0, replied: 0, failed: 0, uncertain: 0, skipped: 0, scheduled: 0,
      cancelled: 0,
    };
    expect(countParts({ ...zero, cancelled: 1, sent: 3, uncertain: 2 })).toEqual([
      { status: 'SENT', label: 'Aceito pelo WhatsApp', count: 3 },
      { status: 'UNCERTAIN', label: 'Situação incerta', count: 2 },
      { status: 'CANCELLED', label: 'Cancelado', count: 1 },
    ]);
  });

  it.each([
    [{ phoneE164: '+5592999990000', name: 'GoZap' }, null, '+5592999990000'],
    [{ phoneE164: null, name: 'Comercial' }, 2, 'Comercial (2)'],
    [{ phoneE164: null, name: null }, null, 'Número removido'],
  ])('channelLabel %j', (channel, count, text) => expect(channelLabel(channel, count)).toBe(text));
});

describe('rótulos de envio', () => {
  it('traduz o motivo de pulo e fixa a frase de demora', () => {
    expect(SKIP_REASON_LABEL).toEqual({
      NO_PHONE: 'sem telefone', SUPPRESSED: 'pediu para não receber (SAIR)', INACTIVE: 'Usuário inativo',
    });
    expect(PACING_HINT).toMatch(/^Os envios saem aos poucos, no ritmo do canal;/);
  });
});

describe('failureReasonLabel', () => {
  const DISCONNECTED = 'Número desconectado';
  const UNCONFIRMED = 'Sem confirmação do WhatsApp — confira no celular antes de reenviar';
  const UNAVAILABLE = 'Serviço de WhatsApp indisponível — avise o administrador';
  it.each([
    ['evolution.session_closed', DISCONNECTED],
    ['gozap.not_connected', DISCONNECTED],
    ['team_whatsapp.channel_disconnected', DISCONNECTED],
    ['team_whatsapp.channel_unverified', 'Não foi possível conferir o número'],
    ['team_whatsapp.channel_unavailable', 'Número indisponível na hora do envio'],
    ['team_whatsapp.channel_invalid', 'Número removido ou inválido'],
    ['gozap.invalid_recipient', 'Número sem WhatsApp ou inválido — confira o telefone no cadastro'],
    ['evolution.number_not_on_whatsapp', 'Número sem WhatsApp ou inválido — confira o telefone no cadastro'],
    ['gozap.timeout', UNCONFIRMED],
    ['evolution.unknown', UNCONFIRMED],
    ['gozap.unknown', UNAVAILABLE],
    ['team_whatsapp.indeterminate', UNCONFIRMED],
    ['evolution.rate_limited', 'Limite de envios do canal atingido — tente mais tarde'],
    ['gozap.quota_exceeded', 'Limite de envios do canal atingido — tente mais tarde'],
    ['gozap.no_token', UNAVAILABLE],
    ['team_whatsapp.queue_unavailable', UNAVAILABLE],
    [null, 'Falha no envio'],
    ['x.y', 'Falha no envio (código x.y)'],
  ])('%s', (code, msg) => expect(failureReasonLabel(code)).toBe(msg));
});

describe('recipientStatusLabel', () => {
  it.each([
    ['QUEUED', null, 'Na fila'],
    ['SENT', null, 'Aceito pelo WhatsApp'],
    ['DELIVERED', null, 'Entregue'],
    ['READ', null, 'Lido'],
    ['REPLIED', null, 'Respondeu'],
    ['UNCERTAIN', null, 'Situação incerta'],
    ['SCHEDULED', null, 'Agendado'],
    ['CANCELLED', null, 'Cancelado'],
    ['FAILED', 'team_whatsapp.channel_disconnected', 'Falhou: Número desconectado'],
    ['FAILED', 'team_whatsapp.channel_invalid', 'Falhou: Número removido ou inválido'],
    ['SKIPPED', 'INACTIVE', 'Pulado: Usuário inativo'],
    ['SKIPPED', 'NO_PHONE', 'Pulado: sem telefone'],
    ['SKIPPED', null, 'Pulado'],
  ] as const)('%s %s', (status, reason, label) => expect(recipientStatusLabel(status, reason)).toBe(label));
});

describe('apiErrorCode', () => {
  /** Erro como o ky 2 o lança: corpo do Response já lido, ProblemDetails em `data`. */
  async function bodyReadError(data: unknown): Promise<HTTPError> {
    const res = new Response(JSON.stringify(data), { status: 409 });
    await res.text();
    const err = new HTTPError(res, new Request('https://api/team-whatsapp/dispatches'), {} as never);
    err.data = data as HTTPError['data'];
    return err;
  }

  it('lê o code de error.data quando o corpo já foi consumido', async () => {
    const err = await bodyReadError({ code: 'team_whatsapp.not_cancellable', status: 409 });
    await expect(apiErrorCode(err)).resolves.toBe('team_whatsapp.not_cancellable');
  });

  it('devolve undefined para erro não HTTP ou corpo em texto', async () => {
    await expect(apiErrorCode(new Error('boom'))).resolves.toBeUndefined();
    await expect(apiErrorCode(await bodyReadError('Bad Gateway'))).resolves.toBeUndefined();
  });
});
