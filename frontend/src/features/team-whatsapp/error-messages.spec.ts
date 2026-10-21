import { describe, expect, it } from 'vitest';
import {
  failureReasonLabel, PACING_HINT, recipientStatusLabel, SKIP_REASON_LABEL, teamErrorMessage,
} from './error-messages';

describe('teamErrorMessage', () => {
  it.each([
    ['team_whatsapp.forbidden', 'Você não tem permissão para enviar a este destino.'],
    ['team_whatsapp.channel_disconnected', 'O canal escolhido está desconectado. Reconecte o número ou escolha outro canal.'],
    ['team_whatsapp.channel_invalid', 'Canal inválido: escolha um canal GoZap ou Evolution ativo.'],
    ['team_whatsapp.no_recipients', 'Ninguém neste destino tem telefone válido para receber.'],
    ['team_whatsapp.invalid_selection', 'A lista de pessoas mudou. Atualize a página e confira de novo.'],
    [undefined, 'Não foi possível enviar a mensagem.'],
    ['outro.codigo', 'Não foi possível enviar a mensagem.'],
  ])('%s', (code, msg) => expect(teamErrorMessage(code)).toBe(msg));
});

describe('rótulos de envio', () => {
  it('traduz o motivo de pulo e fixa a frase de demora', () => {
    expect(SKIP_REASON_LABEL).toEqual({ NO_PHONE: 'sem telefone', SUPPRESSED: 'pediu para não receber (SAIR)' });
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
    [{ status: 'SKIPPED', reason: 'NO_PHONE' }, 'Pulado: sem telefone'],
    [{ status: 'SKIPPED', reason: null }, 'Pulado'],
  ] as const)('%j', (r, label) => expect(recipientStatusLabel(r)).toBe(label));
});
