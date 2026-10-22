import { HTTPError } from 'ky';
import { describe, expect, it } from 'vitest';
import {
  apiErrorCode, cancelErrorMessage, failureReasonLabel, PACING_HINT, recipientStatusLabel, SKIP_REASON_LABEL,
  teamErrorMessage,
} from './error-messages';

describe('teamErrorMessage', () => {
  it.each([
    ['team_whatsapp.forbidden', 'Você não tem permissão para enviar a este destino.'],
    ['team_whatsapp.channel_disconnected', 'O canal escolhido está desconectado. Reconecte o número ou escolha outro canal.'],
    ['team_whatsapp.channel_invalid', 'Canal inválido: escolha um canal GoZap ou Evolution ativo.'],
    ['team_whatsapp.no_recipients', 'Ninguém neste destino tem telefone válido para receber.'],
    ['team_whatsapp.invalid_selection', 'A lista de pessoas mudou. Atualize a página e confira de novo.'],
    ['team_whatsapp.invalid_shift', 'Este turno não está mais disponível. Atualize a página.'],
    ['team_whatsapp.schedule_in_past', 'O início deste turno já passou. Escolha Enviar agora ou outra data.'],
    ['team_whatsapp.not_cancellable', 'Este envio já saiu ou foi cancelado.'],
    ['team_whatsapp.dispatch_not_found', 'Envio não encontrado. Atualize a página.'],
    [undefined, 'Não foi possível enviar a mensagem.'],
    ['outro.codigo', 'Não foi possível enviar a mensagem.'],
  ])('%s', (code, msg) => expect(teamErrorMessage(code)).toBe(msg));
});

describe('cancelErrorMessage', () => {
  const CANCEL_FALLBACK = 'Não foi possível cancelar o envio. Tente de novo.';
  it.each([
    ['team_whatsapp.not_cancellable', 'Este envio já saiu ou foi cancelado.'],
    ['team_whatsapp.dispatch_not_found', 'Envio não encontrado. Atualize a página.'],
    [undefined, CANCEL_FALLBACK],
    ['outro.codigo', CANCEL_FALLBACK],
  ])('%s', (code, msg) => expect(cancelErrorMessage(code)).toBe(msg));
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
  const DISCONNECTED = 'Canal desconectado — reconecte em Números e canais';
  const UNCONFIRMED = 'Sem confirmação do WhatsApp — confira no celular antes de reenviar';
  const UNAVAILABLE = 'Serviço de WhatsApp indisponível — avise o administrador';
  it.each([
    ['evolution.session_closed', DISCONNECTED],
    ['gozap.not_connected', DISCONNECTED],
    ['team_whatsapp.channel_disconnected', DISCONNECTED],
    ['team_whatsapp.channel_unavailable', 'Canal indisponível na hora do envio'],
    ['team_whatsapp.channel_invalid', 'Canal removido ou inválido — escolha outro canal'],
    ['gozap.invalid_recipient', 'Número sem WhatsApp ou inválido — confira o telefone no cadastro'],
    ['evolution.number_not_on_whatsapp', 'Número sem WhatsApp ou inválido — confira o telefone no cadastro'],
    ['gozap.timeout', UNCONFIRMED],
    ['evolution.unknown', UNCONFIRMED],
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
    [{ status: 'QUEUED', reason: null }, 'Na fila'],
    [{ status: 'SENT', reason: null }, 'Enviado'],
    [{ status: 'FAILED', reason: 'evolution.session_closed' }, 'Falhou: Canal desconectado — reconecte em Números e canais'],
    [{ status: 'SCHEDULED', reason: null }, 'Agendado'],
    [{ status: 'CANCELLED', reason: null }, 'Cancelado'],
    [{ status: 'SKIPPED', reason: 'INACTIVE' }, 'Pulado: Usuário inativo'],
    [{ status: 'SKIPPED', reason: 'NO_PHONE' }, 'Pulado: sem telefone'],
    [{ status: 'SKIPPED', reason: null }, 'Pulado'],
  ] as const)('%j', (r, label) => expect(recipientStatusLabel(r)).toBe(label));
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
