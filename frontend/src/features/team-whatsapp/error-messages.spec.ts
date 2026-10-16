import { describe, expect, it } from 'vitest';
import { PACING_HINT, SKIP_REASON_LABEL, teamErrorMessage } from './error-messages';

describe('teamErrorMessage', () => {
  it.each([
    ['team_whatsapp.forbidden', 'Você não tem permissão para enviar a este destino.'],
    ['team_whatsapp.channel_disconnected', 'O canal escolhido está desconectado. Reconecte o número ou escolha outro canal.'],
    ['team_whatsapp.channel_invalid', 'Canal inválido: escolha um canal GoZap ou Evolution ativo.'],
    ['team_whatsapp.no_recipients', 'Ninguém neste destino tem telefone válido para receber.'],
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
