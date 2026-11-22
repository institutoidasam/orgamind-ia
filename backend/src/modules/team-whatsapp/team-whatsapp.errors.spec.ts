import { describe, it, expect } from 'vitest';
import { DomainError } from '../../shared/errors/domain.error';
import {
  BLOCK_TEXT,
  MISSING_ACTIVITY_DATE_TIME_TEXT,
  SCHEDULE_AT_IN_PAST_TEXT,
  audienceBlock,
  audienceChanged,
  blocked,
  invalidBase,
  invalidOffOption,
  invalidReferenceDate,
  noRecipients,
  scheduleInPast,
  sectorWithoutNumber,
  whenNotAllowed,
} from './team-whatsapp.errors';

const view = (e: DomainError) => ({
  code: e.code,
  status: e.status,
  message: e.message,
});

// CF4 + CG4: textos das travas na ordem fixa em que saem.
const ORDERED_BLOCK_TEXTS = [
  ['empty_text', 'Escreva a mensagem.'],
  ['missing_activity', 'Informe a data, a hora e o local da atividade.'],
  ['missing_urgency_reason', 'Informe o motivo da urgência.'],
  [
    'overtime_without_selection',
    'Marque pelo menos uma pessoa para a hora extra.',
  ],
  ['schedule_in_past', 'O início deste turno já passou'],
  ['schedule_too_far', 'O envio pode ser agendado para até 30 dias à frente.'],
  [
    'after_activity_start',
    'A mensagem precisa sair antes do início da atividade.',
  ],
  ['no_recipients', 'Nenhum destinatário válido'],
  ['sector_without_number', 'Há área sem número neste envio'],
];

describe('travas de data e hora (CG4)', () => {
  it('BLOCK_TEXT tem schedule_too_far e o texto de data e hora já passadas', () => {
    expect(view(blocked(audienceBlock('schedule_too_far')))).toEqual({
      code: 'team_whatsapp.schedule_too_far',
      status: 422,
      message: 'O envio pode ser agendado para até 30 dias à frente.',
    });
    expect(audienceBlock('schedule_in_past', SCHEDULE_AT_IN_PAST_TEXT)).toEqual(
      {
        code: 'team_whatsapp.schedule_in_past',
        message: 'A data e a hora do envio já passaram.',
      },
    );
  });
});

describe('erros da finalidade (CF4)', () => {
  it('audience_changed é 409 com o texto da spec', () => {
    expect(view(audienceChanged())).toEqual({
      code: 'team_whatsapp.audience_changed',
      status: 409,
      message:
        'O público mudou depois da prévia. Confira de novo antes de enviar.',
    });
  });

  it.each([
    [invalidBase, 'invalid_base', 'A base do público desta finalidade é fixa.'],
    [
      invalidOffOption,
      'invalid_off_option',
      'A equipe em serviço não tem a opção de incluir quem está de folga.',
    ],
    [
      whenNotAllowed,
      'when_not_allowed',
      'Esta finalidade não pode ser enviada nesse momento.',
    ],
    [
      invalidReferenceDate,
      'invalid_reference_date',
      'A data de referência precisa ser a data da atividade.',
    ],
  ])('erro de regra %# é 422 com o texto da spec', (make, code, message) => {
    expect(view(make())).toEqual({
      code: `team_whatsapp.${code}`,
      status: 422,
      message,
    });
  });

  it('blocked devolve 422 com o código e o texto do bloco', () => {
    const block = audienceBlock('missing_activity');
    expect(view(blocked(block))).toEqual({ ...block, status: 422 });
    expect(blocked(block)).toBeInstanceOf(DomainError);
    expect(
      audienceBlock('missing_activity', MISSING_ACTIVITY_DATE_TIME_TEXT),
    ).toEqual({
      code: 'team_whatsapp.missing_activity',
      message: 'Informe a data e a hora da atividade.',
    });
  });
});

describe('textos das travas (CF4), na ordem fixa', () => {
  it('BLOCK_TEXT traz os textos da spec na ordem das travas', () => {
    expect(Object.entries(BLOCK_TEXT)).toEqual(ORDERED_BLOCK_TEXTS);
  });

  it('as travas que já existiam continuam 422 com o código e o texto de hoje', () => {
    expect(
      [noRecipients(), scheduleInPast(), sectorWithoutNumber()].map(view),
    ).toEqual([
      {
        code: 'team_whatsapp.no_recipients',
        status: 422,
        message: 'Nenhum destinatário válido',
      },
      {
        code: 'team_whatsapp.schedule_in_past',
        status: 422,
        message: 'O início deste turno já passou',
      },
      {
        code: 'team_whatsapp.sector_without_number',
        status: 422,
        message: 'Há área sem número neste envio',
      },
    ]);
  });
});
