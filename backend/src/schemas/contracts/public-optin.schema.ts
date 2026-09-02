import { z } from 'zod';
import { dateFromIso } from './date.schema';

/**
 * C4 — a submissão da landing page pública `/opt-in` (spec §3.2).
 *
 * Este é o ÚNICO contrato de escrita de consentimento exposto sem autenticação,
 * então tudo aqui é deliberadamente estreito: o titular escolhe o telefone, o
 * nome e o aceite; **não** escolhe o texto, **não** escolhe a fonte, **não**
 * escolhe a data. Deixar o cliente mandar o `evidenceText` seria deixar o
 * navegador escrever a prova — o corpo é resolvido no servidor, a partir do
 * `ConsentText` versionado da finalidade.
 */
export const publicOptInSchema = z.object({
  /**
   * Como o titular digitou (`(92) 98765-4321`, `+55 92 98765-4321`). A
   * normalização para E.164 é do servidor, pelo MESMO helper do import
   * (libphonenumber) — um regex de E.164 aceitaria `+99999999999`, que não é
   * número de lugar nenhum.
   */
  phone: z.string().trim().min(8).max(24),
  /** Opcional (spec §3.2): exigir nome numa landing rural derruba conversão. */
  name: z.string().trim().max(120).optional(),
  /** Finalidade (key de ConsentPurpose ATIVA). Vem do link/QR ou da query. */
  purposeKey: z.string().trim().min(1).max(64),
  /**
   * O ATO AFIRMATIVO. Caixa nunca pré-marcada, consentimento nunca embutido em
   * "aceito os termos" (spec §3.2). `false` é recusado com mensagem, não
   * silenciosamente ignorado.
   */
  accepted: z.boolean(),
  /**
   * HONEYPOT. Campo escondido por CSS que humano nenhum vê e bot de formulário
   * preenche por reflexo. Preenchido → 200 genérico e nada é gravado (a resposta
   * é indistinguível do sucesso, senão o bot aprende a deixá-lo vazio).
   *
   * Captcha está PROIBIDO nesta feature: o público é ribeirinho/rural, com
   * conectividade ruim — captcha derruba conversão e exclui exatamente quem a
   * landing existe para alcançar.
   */
  website: z.string().max(200).optional(),
  /**
   * Quando a página renderizou o texto. Serve a duas coisas: entra na evidência
   * (spec §2.4, `renderedAt`) e alimenta o time-to-submit (< 2s = bot).
   *
   * É informação do cliente e portanto forjável — é defesa em profundidade, não
   * a proteção dura. A proteção dura é o rate limit por IP.
   */
  renderedAt: dateFromIso().optional(),
});

export type PublicOptIn = z.infer<typeof publicOptInSchema>;
