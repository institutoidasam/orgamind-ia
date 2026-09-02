import { z } from 'zod';
import { filterGroupSchema } from './filter.schema';
import { dateFromIso } from './date.schema';

/**
 * Administração do consentimento: as finalidades (§2.2) e os textos canônicos
 * versionados (§3.0).
 *
 * Antes disto, as 5 finalidades de referência e os textos que as declaram só
 * existiam na migração de referência — o primeiro cliente do sistema não tinha
 * como ter a finalidade DELE, e o texto que os titulares dele liam nomeava a
 * organização errada. Um texto que nomeia a organização errada não é um detalhe
 * de copy: é um consentimento inválido (a Meta exige *"clearly state the
 * business's name"*), colhido de gente real.
 */

/**
 * A `key` é o slug ESTÁVEL: entra no gate, em `Campaign.purposeKey`, em cada
 * `ConsentEvent` da trilha e no texto pré-preenchido de cartazes já impressos.
 * Por isso o alfabeto é estreito (a-z, 0-9, _) e ela é imutável depois de criada
 * — renomear órfã a trilha, e a trilha é a prova (art. 8º §2º).
 */
export const purposeKeySchema = z
  .string()
  .trim()
  .min(2)
  .max(64)
  .regex(
    /^[a-z0-9_]+$/,
    'A chave aceita apenas letras minúsculas, números e _ (ex.: convite_atividades).',
  );

export const createPurposeSchema = z.object({
  key: purposeKeySchema,
  /** Rótulo curto — é ele que aparece DENTRO do texto de consentimento. */
  label: z.string().trim().min(1, 'Informe o rótulo da finalidade.').max(120),
  /** O que exatamente será enviado, em linguagem de titular. */
  description: z
    .string()
    .trim()
    .min(1, 'Descreva o que será enviado nesta finalidade.')
    .max(500),
  /**
   * art. 11 — dado sensível exige consentimento específico e destacado, e o
   * legítimo interesse não se aplica. O gate RECUSA override aqui.
   */
  isSensitive: z.boolean().default(false),
  active: z.boolean().default(true),
});

/**
 * `key` ausente de propósito (e removida se vier no corpo): editar rótulo,
 * descrição ou sensibilidade é corrigir a apresentação; trocar a key é trocar a
 * identidade da finalidade sob os consentimentos já colhidos.
 */
export const updatePurposeSchema = z
  .object({
    label: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().min(1).max(500).optional(),
    isSensitive: z.boolean().optional(),
    active: z.boolean().optional(),
  })
  .strip();

export const createConsentTextSchema = z.object({
  purposeKey: purposeKeySchema,
  /** Rótulo da versão: `optin-v1`, `optin-continuum-v2`. Único por finalidade. */
  version: z
    .string()
    .trim()
    .min(1, 'Informe a versão do texto (ex.: optin-v1).')
    .max(64)
    .regex(
      /^[A-Za-z0-9._-]+$/,
      'A versão aceita letras, números, ponto, hífen e _ (ex.: optin-v2).',
    ),
  /**
   * O corpo canônico. Publicar uma versão nova NÃO altera as anteriores: os
   * consentimentos já colhidos continuam apontando para o texto que a pessoa
   * viu — é isso que os torna prova em 2028.
   */
  body: z
    .string()
    .trim()
    .min(1, 'Escreva o texto de consentimento.')
    .max(4000),
  /** Quando esta versão passa a valer. Default: agora. */
  activeFrom: dateFromIso().optional(),
});

/**
 * §6.2 coorte C2 — backfill auditado da base histórica.
 *
 * A base legada do cliente tem base legal (os titulares concordaram em receber,
 * FORA do WhatsApp), mas nenhum `ConsentEvent` — então o gate, corretamente,
 * pula 100% dela e nenhuma campanha sai. Este é o caminho para registrar aquele
 * consentimento pré-existente SEM enviar nada.
 *
 * A evidência é OBRIGATÓRIA, e é o ponto inteiro deste endpoint: um GRANT em
 * massa sem "onde a pessoa concordou" e "quando" é exatamente a autorização
 * genérica que o art. 8º §4º anula — e seria produzido pelo próprio controlador,
 * o que num processo sancionador é prova contra ele, não a favor.
 */
export const bulkGrantSchema = z.object({
  purposeKey: purposeKeySchema,
  /** Mesmo seletor de audiência das campanhas (reuso literal). */
  filters: filterGroupSchema,
  /** ONDE concordaram. Ex.: "Contrato CONTINUUM #123", "Fichas do evento X". */
  evidenceRef: z
    .string({
      error:
        'Informe a evidência: onde estes titulares concordaram (ex.: "Contrato CONTINUUM #123").',
    })
    .trim()
    .min(
      3,
      'Informe a evidência: onde estes titulares concordaram (ex.: "Contrato CONTINUUM #123").',
    )
    .max(200),
  /** QUANDO concordaram. Vira o `occurredAt` do evento — nunca "agora". */
  collectedAt: dateFromIso({
    error: 'Informe a data em que estes titulares concordaram.',
  }),
  evidenceNote: z.string().trim().max(1000).optional(),
});

/**
 * A data da coleta é PASSADO: consentimento que ainda não aconteceu não existe.
 * Fica fora do objeto base para o preview poder reusar o mesmo refinamento.
 */
export const bulkGrantWithPastDateSchema = bulkGrantSchema.refine(
  (v) => v.collectedAt.getTime() <= Date.now(),
  {
    path: ['collectedAt'],
    error: 'A data da coleta precisa estar no passado.',
  },
);

export type CreatePurpose = z.infer<typeof createPurposeSchema>;
export type UpdatePurpose = z.infer<typeof updatePurposeSchema>;
export type CreateConsentText = z.infer<typeof createConsentTextSchema>;
export type BulkGrant = z.infer<typeof bulkGrantSchema>;
