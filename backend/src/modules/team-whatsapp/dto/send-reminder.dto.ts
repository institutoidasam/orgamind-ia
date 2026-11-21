import { z } from 'zod';

/**
 * CI7 (I7, DI10): corpo de `POST dispatches/:id/reminders`. Destinatários do
 * alerta escolhidos na tela: 1 a 500 ids (o teto da seleção nominal), sem
 * repetição (400). O servidor refaz a lista dos elegíveis e envia à
 * interseção; id fora dela é ignorado, nunca acrescentado. A rota valida com
 * `ZodValidationPipe(sendReminderSchema)`, como o "Repetir".
 */
export const sendReminderSchema = z.object({
  recipientIds: z
    .array(z.string().min(1))
    .min(1)
    .max(500)
    .refine((ids) => new Set(ids).size === ids.length, {
      message: 'Há destinatários repetidos.',
    }),
});

export type SendReminderInput = z.infer<typeof sendReminderSchema>;
