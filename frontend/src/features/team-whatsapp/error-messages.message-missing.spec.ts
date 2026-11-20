import { describe, expect, it } from 'vitest';
import { failureReasonLabel, recipientStatusLabel } from './error-messages';

describe('team_whatsapp.message_missing: rótulo próprio do motivo de falha', () => {
  it('message_missing tem rótulo próprio', () => {
    const label = 'Mensagem preparada não encontrada — crie um envio novo para essa pessoa';
    expect(failureReasonLabel('team_whatsapp.message_missing')).toBe(label);
    expect(recipientStatusLabel('FAILED', 'team_whatsapp.message_missing')).toBe(`Falhou: ${label}`);
  });
});
