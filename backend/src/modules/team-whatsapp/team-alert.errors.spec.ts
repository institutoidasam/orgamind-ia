import { describe, expect, it } from 'vitest';
import type { DomainError } from '../../shared/errors/domain.error';
import {
  ackExists,
  ackNotManual,
  notAnAlert,
  reminderEmpty,
  reminderLimit,
  reminderTooSoon,
} from './team-alert.errors';

const view = (e: DomainError) => ({
  code: e.code,
  status: e.status,
  message: e.message,
});

describe('erros do alerta urgente (DI14)', () => {
  it('cada erro tem o código team_whatsapp.<x> e o status de DI14', () => {
    expect([
      view(notAnAlert()),
      view(ackExists()),
      view(ackNotManual()),
      view(reminderEmpty()),
      view(reminderLimit()),
      view(reminderTooSoon()),
    ]).toEqual([
      {
        code: 'team_whatsapp.not_an_alert',
        status: 422,
        message: 'Este envio não é um alerta urgente.',
      },
      {
        code: 'team_whatsapp.ack_exists',
        status: 422,
        message: 'Esta pessoa já tem ciência registrada.',
      },
      {
        code: 'team_whatsapp.ack_not_manual',
        status: 422,
        message: 'Só a ciência manual pode ser desfeita.',
      },
      {
        code: 'team_whatsapp.reminder_empty',
        status: 422,
        message:
          'Nenhuma das pessoas escolhidas está pendente. Atualize a lista.',
      },
      {
        code: 'team_whatsapp.reminder_limit',
        status: 409,
        message: 'Este alerta já teve 3 lembretes, o máximo.',
      },
      {
        code: 'team_whatsapp.reminder_too_soon',
        status: 409,
        message: 'Espere 5 minutos desde o alerta ou o último lembrete.',
      },
    ]);
  });
});
