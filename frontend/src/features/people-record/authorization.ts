import { z } from 'zod';
import { formatDatePtBr } from '@/lib/format-date-ptbr';

/** Fuso do app para datas civis (GC8). */
const APP_TIME_ZONE = 'America/Manaus';

export const contactAuthorizationSchema = z.object({
  status: z.enum(['AUTORIZADO', 'NAO_AUTORIZADO']),
  source: z.enum(['TERMO_ASSINADO', 'FICHA_ADMISSAO', 'ACEITE_WHATSAPP', 'OUTRO', 'CADASTRO_ANTERIOR']).nullable(),
  note: z.string().nullable(),
  date: z.string().nullable(),
  recordedAt: z.string().nullable(),
});

export type ContactAuthorization = z.infer<typeof contactAuthorizationSchema>;

/** `CADASTRO_ANTERIOR` só existe pela migração: a API recusa esse valor na entrada. */
export type AuthorizationSource = 'TERMO_ASSINADO' | 'FICHA_ADMISSAO' | 'ACEITE_WHATSAPP' | 'OUTRO';

export type AuthorizationChoice =
  | { status: 'NAO_AUTORIZADO' }
  | { status: 'AUTORIZADO'; source: AuthorizationSource; note?: string; date: string };

export type ContactAuthorizationInput =
  | { status: 'NAO_AUTORIZADO' }
  | { status: 'AUTORIZADO'; source: AuthorizationSource; note?: string; date?: string };

export const AUTHORIZATION_SOURCE_LABEL: Record<AuthorizationSource, string> = {
  TERMO_ASSINADO: 'Termo assinado',
  FICHA_ADMISSAO: 'Ficha de admissão',
  ACEITE_WHATSAPP: 'Aceite pelo WhatsApp',
  OUTRO: 'Outro',
};

/** Data civil de hoje (aaaa-mm-dd) no fuso do app. */
export function todayInManaus(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: APP_TIME_ZONE }).format(new Date());
}

function sourceText(a: ContactAuthorization): string {
  if (a.source === null) return 'Autorizado';
  if (a.source === 'CADASTRO_ANTERIOR') return 'Cadastro anterior — origem não verificada';
  const label = AUTHORIZATION_SOURCE_LABEL[a.source];
  return a.source === 'OUTRO' && a.note ? `${label} (${a.note})` : label;
}

/** Texto da autorização para a tela; nunca o valor cru do enum. */
export function authorizationLabel(a: ContactAuthorization): string {
  if (a.status === 'NAO_AUTORIZADO') return 'Sem autorização registrada';
  const text = sourceText(a);
  return a.source === 'CADASTRO_ANTERIOR' || !a.date ? text : `${text} em ${formatDatePtBr(a.date)}`;
}

/** O que o selo da lista sinaliza; origem verificada não sinaliza nada. */
export function authorizationFlag(a: ContactAuthorization): 'unverified' | 'not_authorized' | null {
  if (a.status === 'NAO_AUTORIZADO') return 'not_authorized';
  return a.source === 'CADASTRO_ANTERIOR' ? 'unverified' : null;
}

/** Escolha da tela → corpo da API. Nota só no "Outro"; data vazia deixa o serviço usar hoje. */
export function toAuthorizationInput(c: AuthorizationChoice): ContactAuthorizationInput {
  if (c.status === 'NAO_AUTORIZADO') return { status: 'NAO_AUTORIZADO' };
  const note = c.source === 'OUTRO' ? c.note?.trim() : undefined;
  return {
    status: 'AUTORIZADO',
    source: c.source,
    ...(note ? { note } : {}),
    ...(c.date ? { date: c.date } : {}),
  };
}

/** Validação da escolha para os formulários; `undefined` = válida. */
export function authorizationChoiceError(choice: AuthorizationChoice | null): string | undefined {
  if (choice === null) return 'Escolha a autorização de contato';
  if (choice.status === 'NAO_AUTORIZADO') return undefined;
  if (choice.source === 'OUTRO' && !choice.note?.trim()) return 'Descreva a origem da autorização';
  if (!choice.date) return 'Informe a data da autorização';
  return choice.date > todayInManaus() ? 'A data da autorização não pode ser futura' : undefined;
}
