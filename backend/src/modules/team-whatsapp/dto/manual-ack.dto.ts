import { z } from 'zod';

/**
 * CI6 (I5): corpo de `POST dispatches/:id/recipients/:recipientId/ack`. A
 * observação é obrigatória, aparada, de 1 a 200 caracteres (a coluna é
 * `VarChar(200)`); só espaços sobra vazia e é 400. A rota valida com
 * `ZodValidationPipe(manualAckSchema)`, como o "Repetir".
 */
export const manualAckSchema = z.object({
  note: z.string().trim().min(1).max(200),
});

export type ManualAckInput = z.infer<typeof manualAckSchema>;
