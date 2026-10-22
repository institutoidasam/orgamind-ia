import { describe, expect, it } from 'vitest';
import { CreateShiftDto } from './create-shift.dto';
import { ReorderShiftsDto } from './reorder-shifts.dto';
import { UpdateShiftDto } from './update-shift.dto';

const NIGHT = { name: 'Noite', startTime: '22:00', endTime: '06:00' };

describe('DTOs de turno', () => {
  it('aceita turno que atravessa a meia-noite e apara o nome', () => {
    expect(CreateShiftDto.schema.parse({ ...NIGHT, name: ' Noite ' })).toEqual(
      NIGHT,
    );
  });

  it.each(['24:00', '7:00', '07:60'])('HH:mm inválido %j → falha', (time) => {
    expect(
      CreateShiftDto.schema.safeParse({ ...NIGHT, startTime: time }).success,
    ).toBe(false);
    expect(UpdateShiftDto.schema.safeParse({ endTime: time }).success).toBe(
      false,
    );
  });

  it.each(['', '   ', 'x'.repeat(41)])('nome %j → falha', (name) => {
    expect(CreateShiftDto.schema.safeParse({ ...NIGHT, name }).success).toBe(
      false,
    );
  });

  it('PATCH {} → falha', () => {
    expect(UpdateShiftDto.schema.safeParse({}).success).toBe(false);
    expect(UpdateShiftDto.schema.safeParse({ isActive: false }).success).toBe(
      true,
    );
  });

  it.each([[[]], [Array.from({ length: 101 }, (_, i) => `shift_${i}`)]])(
    'ordem fora de 1..100 ids → falha',
    (ids) => {
      expect(ReorderShiftsDto.schema.safeParse({ ids }).success).toBe(false);
    },
  );
});
