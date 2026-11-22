import { z } from 'zod';

/**
 * C6: corpo de `POST dispatches/:id/retry`. Ou uma lista de 1..100 destinatários,
 * ou `{ all: true }` (todas as falhas certas do envio); as duas formas são
 * `.strict()`, então corpo vazio, `all: false` e as duas juntas são 400. União
 * (não classe): `createZodDto` de uma união não vira classe no TS, então o
 * controller valida com `ZodValidationPipe(retryRecipientsSchema)`.
 */
export const retryRecipientsSchema = z.union([
  z
    .object({ recipientIds: z.array(z.string().min(1)).min(1).max(100) })
    .strict(),
  z.object({ all: z.literal(true) }).strict(),
]);

export type RetryRecipientsInput = z.infer<typeof retryRecipientsSchema>;
