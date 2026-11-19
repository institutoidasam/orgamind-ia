import { z } from 'zod';
import { civilDateSchema } from './civil-date.schema';

export const contactAuthorizationStatusSchema = z.enum([
  'AUTORIZADO',
  'NAO_AUTORIZADO',
]);

/** `CADASTRO_ANTERIOR` só existe pela migração: não é aceito na entrada. */
export const contactAuthorizationSourceSchema = z.enum([
  'TERMO_ASSINADO',
  'FICHA_ADMISSAO',
  'ACEITE_WHATSAPP',
  'OUTRO',
  'CADASTRO_ANTERIOR',
]);

const NOTE_MAX_LENGTH = 120;

/** Saída: como a autorização de contato aparece na API. */
export const contactAuthorizationSchema = z.object({
  status: contactAuthorizationStatusSchema,
  source: contactAuthorizationSourceSchema.nullable(),
  note: z.string().nullable(),
  date: civilDateSchema.nullable(),
  recordedAt: z.string().nullable(),
});

/** Entrada: `NAO_AUTORIZADO` não leva mais nada; `AUTORIZADO` exige a origem. */
export const contactAuthorizationInputSchema = z
  .discriminatedUnion('status', [
    z.object({ status: z.literal('NAO_AUTORIZADO') }).strict(),
    z
      .object({
        status: z.literal('AUTORIZADO'),
        source: z.enum([
          'TERMO_ASSINADO',
          'FICHA_ADMISSAO',
          'ACEITE_WHATSAPP',
          'OUTRO',
        ]),
        note: z.string().trim().max(NOTE_MAX_LENGTH).optional(),
        // Ausente = hoje (o serviço preenche).
        date: civilDateSchema.optional(),
      })
      .strict(),
  ])
  .refine(
    (value) =>
      value.status !== 'AUTORIZADO' ||
      value.source !== 'OUTRO' ||
      (value.note ?? '').length > 0,
    { message: 'Informe o detalhe da origem', path: ['note'] },
  );

export type ContactAuthorization = z.infer<typeof contactAuthorizationSchema>;
export type ContactAuthorizationInput = z.infer<
  typeof contactAuthorizationInputSchema
>;
