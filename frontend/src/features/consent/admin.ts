import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { api } from '@/lib/api-client';
import type { FilterGroup } from '@/features/campaigns/schemas';

/**
 * Administração das finalidades e dos textos de consentimento (spec §2.2, §3.0).
 *
 * Antes disto, as finalidades e os textos só nasciam da migração de referência —
 * com o nome de uma organização específica dentro. Um cliente novo não tinha como
 * colher consentimento válido: a Meta exige que o texto **nomeie a organização**,
 * e um texto que nomeia a organização errada não é um erro de copy, é um
 * consentimento inválido colhido de gente real.
 *
 * Hoje a organização é CONFIGURAÇÃO (`/organization`, tela de Configurações), e
 * o rascunho de um texto novo já vem composto com ela — ver
 * `useSuggestedConsentText`.
 */

export const consentTextSchema = z.object({
  id: z.string(),
  version: z.string(),
  body: z.string(),
  activeFrom: z.coerce.date(),
  createdAt: z.coerce.date(),
});
export type ConsentText = z.infer<typeof consentTextSchema>;

export const adminPurposeSchema = z.object({
  key: z.string(),
  label: z.string(),
  description: z.string(),
  isSensitive: z.boolean(),
  active: z.boolean(),
  /** Todas as versões, da mais nova para a mais antiga. */
  texts: z.array(consentTextSchema),
  /** A versão vigente. null = a finalidade ainda não coleta nada. */
  activeText: consentTextSchema.nullable(),
  /** O que impede apagar a finalidade (a trilha é prova, e prova não se apaga). */
  consents: z.number(),
  events: z.number(),
  campaigns: z.number(),
});
export type AdminPurpose = z.infer<typeof adminPurposeSchema>;

const adminPurposeListSchema = z.array(adminPurposeSchema);

export type CreatePurposeInput = {
  key: string;
  label: string;
  description: string;
  isSensitive: boolean;
  active: boolean;
};

export type UpdatePurposeInput = {
  key: string;
  label?: string;
  description?: string;
  isSensitive?: boolean;
  active?: boolean;
};

export type PublishTextInput = {
  purposeKey: string;
  version: string;
  body: string;
};

/** Prefixo compartilhado com `useConsentPurposes` (ativas): invalidar aqui invalida lá. */
const PURPOSES_KEY = ['consent', 'purposes'] as const;

export function useAdminPurposes() {
  return useQuery({
    queryKey: [...PURPOSES_KEY, 'admin'] as const,
    queryFn: async () =>
      adminPurposeListSchema.parse(await api.get('consent/purposes/all').json()),
  });
}

export function useCreatePurpose() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreatePurposeInput) =>
      adminPurposeSchema.parse(
        await api.post('consent/purposes', { json: input }).json(),
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: PURPOSES_KEY }),
  });
}

export function useUpdatePurpose() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ key, ...patch }: UpdatePurposeInput) =>
      adminPurposeSchema.parse(
        await api.patch(`consent/purposes/${key}`, { json: patch }).json(),
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: PURPOSES_KEY }),
  });
}

/**
 * Só apaga finalidade VIRGEM — o backend recusa (409, PT-BR) qualquer uma com
 * consentimento, evento, campanha ou ponto de coleta vinculado, e manda desativar.
 */
export function useDeletePurpose() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (key: string) => {
      await api.delete(`consent/purposes/${key}`);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: PURPOSES_KEY }),
  });
}

/**
 * O RASCUNHO de uma versão nova, composto pelo backend com a identidade
 * CONFIGURADA da organização — o caminho para trocar a organização nomeada num
 * texto de consentimento sem tocar no que já foi publicado.
 *
 * `activeTextNamesOrganization: false` é o alarme: o texto que está colhendo
 * consentimento HOJE nomeia outra organização.
 */
export const suggestedConsentTextSchema = z.object({
  purposeKey: z.string(),
  version: z.string(),
  body: z.string(),
  activeTextNamesOrganization: z.boolean(),
});
export type SuggestedConsentText = z.infer<typeof suggestedConsentTextSchema>;

export function useSuggestedConsentText(purposeKey: string | null) {
  return useQuery({
    queryKey: [...PURPOSES_KEY, 'suggested-text', purposeKey] as const,
    enabled: purposeKey !== null,
    queryFn: async () =>
      suggestedConsentTextSchema.parse(
        await api
          .get('consent/texts/suggested', {
            searchParams: { purposeKey: purposeKey ?? '' },
          })
          .json(),
      ),
  });
}

/**
 * Publica uma versão NOVA. Nunca reescreve as anteriores: os consentimentos já
 * colhidos apontam para o texto que a pessoa LEU — é ele que os prova em 2028
 * (art. 8º §2º: o ônus da prova é do controlador).
 */
export function usePublishConsentText() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: PublishTextInput) =>
      consentTextSchema.parse(
        await api.post('consent/texts', { json: input }).json(),
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: PURPOSES_KEY }),
  });
}

// ── Registro de consentimento da base existente (§6.2 C2) ────────────────────

/**
 * A base legada tem base legal (os titulares concordaram, FORA do WhatsApp) mas
 * nenhum ConsentEvent — então o gate por finalidade pula 100% dela e nenhuma
 * campanha sai. Este é o caminho para registrar aquele consentimento sem enviar
 * nada. A evidência (onde + quando) é obrigatória: sem ela, o registro seria a
 * autorização genérica que a LGPD anula.
 */
export type BulkGrantInput = {
  purposeKey: string;
  filters: FilterGroup;
  evidenceRef: string;
  /** `yyyy-mm-dd` do `<input type=date>` — data de calendário, no passado. */
  collectedAt: string;
  evidenceNote?: string;
};

export type BulkGrantResult = {
  total: number;
  granted: number;
  skippedSuppressed: number;
  alreadyGranted: number;
  failed: number;
};

/** Quantos serão afetados — o número que o operador vê ANTES de confirmar. */
export function useBulkGrantPreview() {
  return useMutation({
    mutationFn: async (input: BulkGrantInput): Promise<BulkGrantResult> =>
      api
        .post('consent/bulk-grant/preview', { json: input })
        .json<BulkGrantResult>(),
  });
}

export function useBulkGrant() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: BulkGrantInput): Promise<BulkGrantResult> =>
      api.post('consent/bulk-grant', { json: input }).json<BulkGrantResult>(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: PURPOSES_KEY });
      // O painel inteiro muda: "quem pode receber campanha hoje" é a métrica que
      // este registro existe para mover.
      qc.invalidateQueries({ queryKey: ['consent', 'overview'] });
    },
  });
}

// ── Preview do texto (como o titular o vê) ───────────────────────────────────

/**
 * A DECLARAÇÃO: a 1ª linha do corpo — a frase que nomeia a organização e a
 * finalidade. É só ela que viaja no `?text=` do wa.me (espelha
 * `declarationFrom` do backend): o corpo inteiro, num link, vira um parágrafo
 * que o titular apaga antes de enviar — e texto apagado é consentimento perdido.
 */
export function declarationFrom(body: string): string {
  return body
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0) ?? '';
}

/** Como a landing renderiza: `{url}` resolvido para a política de privacidade. */
export function renderLandingBody(body: string, origin?: string): string {
  const base = (origin ?? window.location.origin).replace(/\/+$/, '');
  return body.replaceAll('{url}', `${base}/privacidade`);
}

/** O link wa.me que um ponto de coleta desta finalidade vai gerar. */
export function waMePreview(
  body: string,
  senderDigits: string,
  token = 'FEIRA-MANAUS-2026',
): string {
  const text = `${declarationFrom(body)} [${token}]`;
  return `https://wa.me/${senderDigits}?text=${encodeURIComponent(text)}`;
}

/**
 * Os requisitos legais do texto (spec §3.0) como CHECKLIST, não como validação.
 *
 * Deliberadamente não bloqueia o envio: a heurística é textual e erraria — um
 * texto perfeitamente válido que diga "pode cancelar quando quiser" não contém a
 * palavra PARAR, e travar o formulário nisso ensinaria o operador a escrever para
 * o validador, não para o titular. Quem responde pelo texto é o ADMIN; o orgamind
 * mostra o que a lei e a Meta exigem e marca o que já reconheceu.
 */
export type LegalCheck = { id: string; label: string; ok: boolean };

export function consentTextChecklist(body: string): LegalCheck[] {
  const t = body
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

  return [
    {
      id: 'organizacao',
      label: 'Nomeia a organização (razão social por extenso)',
      // A Meta exige *"clearly state the business's name"*. Não dá para adivinhar
      // o nome — o que dá para reconhecer é a estrutura "Autorizo o X (…)".
      ok: /autorizo\s+[ao]?\s*\S+/.test(t) && /\(.+\)/.test(body),
    },
    {
      id: 'finalidade',
      label: 'Diz o que exatamente será enviado (a finalidade)',
      ok: /(sobre|com|para)\s+\S+/.test(t) && t.length > 60,
    },
    {
      id: 'canal',
      label: 'Diz que as mensagens vêm por WhatsApp',
      ok: t.includes('whatsapp'),
    },
    {
      id: 'frequencia',
      label: 'Diz a frequência aproximada (ex.: "no máximo 2 por mês")',
      ok: /(por mes|por semana|mensagens por|no maximo)/.test(t),
    },
    {
      id: 'saida',
      label: 'Diz como sair (ex.: responder PARAR)',
      ok: /(parar|sair|cancelar|descadastr)/.test(t),
    },
    {
      id: 'nao_retaliacao',
      label: 'Diz que recusar NÃO prejudica o titular',
      ok: /(nao afeta|nao prejudica|sem prejuizo|nao interfere)/.test(t),
    },
  ];
}
