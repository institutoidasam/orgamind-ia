import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { api } from '@/lib/api-client';

/**
 * C5 — o painel de opt-in (spec §7).
 *
 * A métrica de sucesso do orgamind deixa de ser "mensagens enviadas". As três
 * perguntas desta tela: quantos podem receber campanha HOJE, qual canal de coleta
 * funciona, e quanto da base é inutilizável.
 */

export const coorteKeys = [
  'INTERAGIU',
  'DOCUMENTADA_COM_DECLARACAO',
  'DOCUMENTADA_SEM_DECLARACAO',
  'DESCONHECIDA',
  'INVALIDO_NAO_WHATSAPP',
  'NAO_CLASSIFICADO',
] as const;
export type CoorteKey = (typeof coorteKeys)[number];

/** Rótulo da coorte no painel — o operador não fala "DOCUMENTADA_SEM_DECLARACAO". */
export const COORTE_LABEL: Record<CoorteKey, string> = {
  INTERAGIU: 'C1 — Já falou com a gente',
  DOCUMENTADA_COM_DECLARACAO: 'C2 — Origem documentada, com aceite',
  DOCUMENTADA_SEM_DECLARACAO: 'C3 — Origem documentada, sem aceite',
  DESCONHECIDA: 'C4 — Procedência desconhecida',
  INVALIDO_NAO_WHATSAPP: 'C5 — Não existe no WhatsApp',
  NAO_CLASSIFICADO: 'Ainda não classificado',
};

/** O que fazer com cada coorte (spec §6.2) — a tela existe para virar ação. */
export const COORTE_ACAO: Record<CoorteKey, string> = {
  INTERAGIU:
    'Relação demonstrável — mas NÃO é consentimento. Peça a permissão dentro da janela de 24h (grátis) ou convide pelo link/QR.',
  DOCUMENTADA_COM_DECLARACAO:
    'A planilha prova o aceite. Candidatos a backfill de consentimento com a evidência anexa — resolve sem enviar nada.',
  DOCUMENTADA_SEM_DECLARACAO:
    'Coletar telefone não é opt-in. Recoleta só por canal que a pessoa inicia (link, QR, presencial).',
  DESCONHECIDA: 'Não enviar NADA por WhatsApp. Recoleta ou arquivamento.',
  INVALIDO_NAO_WHATSAPP:
    'Número morto: disparar queima cota do tier e derruba a qualidade do número. Excluir da audiência.',
  NAO_CLASSIFICADO: 'Rode a auditoria: sem ela, procedência nenhuma está comprovada.',
};

/** Fonte do consentimento em português (§7: qual canal de coleta funciona). */
export const FONTE_LABEL: Record<string, string> = {
  WA_BUTTON: 'Botão no WhatsApp',
  WA_KEYWORD: 'Palavra-chave (PARAR/VOLTAR)',
  WA_LINK: 'Link wa.me',
  QR_CODE: 'QR Code',
  CTWA_AD: 'Anúncio Click-to-WhatsApp',
  WEB_FORM: 'Landing page',
  PAPER_FORM: 'Ficha de papel',
  MANUAL_ADMIN: 'Registro manual',
  IMPORT_LEGACY: 'Backfill da base histórica',
  PROVIDER_OPTOUT: 'Opt-out pelo provedor',
  SYSTEM_REPAIR: 'Reparo de dados (correção de bug)',
};

const purposeBreakdownSchema = z.object({
  purposeKey: z.string(),
  label: z.string(),
  granted: z.number(),
  /** % da base INTEIRA — não de "quem já consentiu", que seria autoelogio. */
  pctBase: z.number(),
});

const sourceBreakdownSchema = z.object({
  source: z.string(),
  granted: z.number(),
});

/**
 * Funil por token de origem. `inbounds` são as mensagens que chegaram carregando
 * o token; `grants` são as que viraram consentimento. A diferença é o texto
 * pré-preenchido sendo APAGADO antes do envio — problema de copy, não de canal.
 */
const funnelRowSchema = z.object({
  token: z.string(),
  description: z.string().nullable(),
  purposeKey: z.string(),
  active: z.boolean(),
  inbounds: z.number(),
  grants: z.number(),
  conversao: z.number(),
});

export const consentOverviewSchema = z.object({
  total: z.number(),
  /** O número que autoriza apertar um botão. */
  podemReceberHoje: z.number(),
  semConsentimento: z.number(),
  suprimidos: z.number(),
  suprimidosNaSemana: z.number(),
  porFinalidade: z.array(purposeBreakdownSchema),
  porFonte: z.array(sourceBreakdownSchema),
  funil: z.array(funnelRowSchema),
  coortes: z.record(z.enum(coorteKeys), z.number()),
  /** Sem consentimento E sem procedência comprovável. */
  inutilizaveis: z.number(),
  semChecagemWhatsapp: z.number(),
  auditadoEm: z.coerce.date().nullable(),
});
export type ConsentOverview = z.infer<typeof consentOverviewSchema>;

export function useConsentOverview() {
  return useQuery({
    queryKey: ['consent', 'overview'] as const,
    queryFn: async () =>
      consentOverviewSchema.parse(await api.get('consent/overview').json()),
  });
}

const classifyReportSchema = z.object({
  scanned: z.number(),
  updated: z.number(),
  unchanged: z.number(),
});
export type ClassifyReport = z.infer<typeof classifyReportSchema>;

/**
 * Reexecuta a auditoria de procedência (§6.2). Não envia mensagem e não grava
 * consentimento: relê os sinais que já estão no banco e reprojeta as coortes. É
 * idempotente — rodar de novo com a base parada não muda nada.
 */
export function useClassifyBase() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () =>
      classifyReportSchema.parse(await api.post('consent/audit/classify').json()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['consent', 'overview'] }),
  });
}
