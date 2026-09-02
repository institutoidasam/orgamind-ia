import { z } from 'zod';

/**
 * C3 — criação de um ponto de coleta wa.me/QR (spec §3.1).
 *
 * O que o operador escolhe é DE ONDE o consentimento vem (o token) e PARA QUÊ
 * (a finalidade). O texto ele NÃO escolhe: a declaração é montada a partir do
 * `ConsentText` versionado da finalidade. É de propósito — deixar o operador
 * escrever o texto do link seria deixá-lo escrever a prova, e a prova é
 * justamente o que a Meta e o art. 8º §2º exigem que seja padronizado e
 * versionado (nomear a organização, declarar o recebimento, dizer como sair).
 */
export const createOptInLinkSchema = z.object({
  /**
   * Token de origem LEGÍVEL, um por ponto de coleta: `FEIRA-MANAUS-2026`,
   * `PRANCHETA-AGENTE-01`, `INSTA-BIO`. Vira o sufixo `[...]` do texto
   * pré-preenchido — é o que casa o inbound e o que atribui o funil.
   *
   * Só A–Z, 0–9 e hífen: o token viaja dentro de uma URL, é lido em voz alta na
   * rádio comunitária e é redigitado por quem não conseguiu escanear o QR.
   */
  token: z
    .string()
    .trim()
    .toUpperCase()
    .min(3)
    .max(48)
    .regex(
      /^[A-Z0-9][A-Z0-9-]*[A-Z0-9]$/,
      'Use apenas letras (A–Z), números e hífen. Ex.: FEIRA-MANAUS-2026',
    ),
  /** Finalidade (key de ConsentPurpose ATIVA). Sem finalidade não há consentimento válido. */
  purposeKey: z.string().min(1),
  /** Canal cujo número recebe o inbound — é o `<senderDigits>` do wa.me. */
  channelId: z.string().min(1),
  /** Onde este link vai ser distribuído, em português ("Cartaz da feira de Manaus"). */
  description: z.string().trim().max(200).optional(),
});

export const setOptInLinkActiveSchema = z.object({
  active: z.boolean(),
});

export type CreateOptInLink = z.infer<typeof createOptInLinkSchema>;
export type SetOptInLinkActive = z.infer<typeof setOptInLinkActiveSchema>;
