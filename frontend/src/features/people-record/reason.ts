import { z } from 'zod';

export const REASON_MESSAGE = 'Informe o motivo, de 3 a 200 caracteres';

/** Motivo da alteração (spec A4): aparado, de 3 a 200 caracteres. */
export const reasonSchema = z.string().trim().min(3, REASON_MESSAGE).max(200, REASON_MESSAGE);
