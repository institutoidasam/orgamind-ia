import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * ★ I15 — "o canal morreu: estas mensagens nunca chegaram".
 *
 * `confirm` é obrigatório e não tem default: o operador acabou de ver, na
 * prévia, QUANTAS pessoas voltam a ser alcançáveis por este template, e este
 * campo é o "sim, são essas". Sem ele um POST acidental (retry de cliente HTTP,
 * link colado, duplo clique) desfaria o bloqueio de milhares de eleitores.
 *
 * `reason` é texto livre e vai INTEIRO para o audit. Ele não muda o
 * comportamento — existe para que, meses depois, dê para saber por que aquelas
 * 13.000 linhas foram declaradas não entregues, e por quem.
 *
 * O schema mora aqui, e não em `schemas/contracts`, porque nada no frontend
 * precisa dele: é um corpo de duas chaves, consumido num endpoint só.
 */
export const releaseUnconfirmedSentSchema = z.object({
  confirm: z.boolean(),
  reason: z.string().trim().max(500).optional(),
});

export type ReleaseUnconfirmedSent = z.infer<
  typeof releaseUnconfirmedSentSchema
>;

export class ReleaseUnconfirmedSentDto extends createZodDto(
  releaseUnconfirmedSentSchema,
) {}
