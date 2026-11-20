import { createHmac } from 'node:crypto';
import type {
  TeamAudienceBase,
  TeamExclusionReason,
  TeamPurpose,
} from '../../schemas/contracts/team-whatsapp.schema';
import type { CivilDate } from '../staff-schedule/civil-date';

/**
 * Rótulo da derivação (DF5). Tem `:`, que não existe em base64url: nenhuma
 * entrada de assinatura de JWT (base64url.base64url) coincide com ele, então
 * a chave do público não sai de uma assinatura HS256 com o mesmo segredo.
 */
const KEY_LABEL = 'team-audience-key:v1';

/**
 * Entrada da impressão do público (CF7). Telefone só de quem recebe: o
 * excluído entra sem número. `shiftIds`/`userIds` nulos = todos / sem seleção
 * nominal (diferente de lista vazia).
 */
export type AudienceKeyInput = {
  rule: {
    purpose: TeamPurpose;
    base: TeamAudienceBase;
    includeOff: boolean;
    date: CivilDate;
    sectorIds: readonly string[];
    shiftIds: readonly string[] | null;
    levelIds: readonly string[];
    withoutLevel: boolean;
    userIds: readonly string[] | null;
  };
  receiving: readonly {
    userId: string;
    sectorId: string;
    shiftId: string | null;
    phone: string;
  }[];
  excluded: readonly {
    userId: string;
    sectorId: string;
    reason: TeamExclusionReason;
  }[];
};

/** Ordem por unidade de código (independe do idioma do processo). */
function byCodeUnit(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

function sortedIds(ids: readonly string[]): string[] {
  return [...new Set(ids)].sort(byCodeUnit);
}

function optionalIds(ids: readonly string[] | null): string[] | null {
  return ids === null ? null : sortedIds(ids);
}

/** Ordena por `userId`; o texto da linha desempata (entrada com repetição). */
function sortRows<T extends { userId: string }>(rows: T[]): T[] {
  return rows
    .map((row) => ({ row, text: JSON.stringify(row) }))
    .sort(
      (a, b) =>
        byCodeUnit(a.row.userId, b.row.userId) || byCodeUnit(a.text, b.text),
    )
    .map(({ row }) => row);
}

/**
 * JSON canônico da impressão (CF7): chaves em ordem fixa, listas por `userId`,
 * ids da regra ordenados e sem repetição, `null` explícito. Só os campos do
 * contrato entram (campo a mais na entrada é ignorado). Contém os telefones de
 * quem recebe: serve só de entrada do HMAC; nunca devolver nem logar.
 *
 * @internal
 */
export function canonicalAudience(input: AudienceKeyInput): string {
  const { rule } = input;
  return JSON.stringify({
    rule: {
      purpose: rule.purpose,
      base: rule.base,
      includeOff: rule.includeOff,
      date: rule.date,
      sectorIds: sortedIds(rule.sectorIds),
      shiftIds: optionalIds(rule.shiftIds),
      levelIds: sortedIds(rule.levelIds),
      withoutLevel: rule.withoutLevel,
      userIds: optionalIds(rule.userIds),
    },
    receiving: sortRows(
      input.receiving.map((r) => ({
        userId: r.userId,
        sectorId: r.sectorId,
        shiftId: r.shiftId ?? null,
        phone: r.phone,
      })),
    ),
    excluded: sortRows(
      input.excluded.map((e) => ({
        userId: e.userId,
        sectorId: e.sectorId,
        reason: e.reason,
      })),
    ),
  });
}

/**
 * Chave da impressão (DF5): HMAC-SHA256(JWT_SECRET, rótulo). Separada do
 * segredo do JWT; nunca logar nem devolver.
 */
export function deriveAudienceSecret(jwtSecret: string): Buffer {
  if (jwtSecret.length === 0) {
    throw new Error('Segredo vazio: impressão do público sem chave');
  }
  return createHmac('sha256', jwtSecret).update(KEY_LABEL).digest();
}

/**
 * Impressão do público (CF7/DF5): HMAC-SHA256 em hex do JSON canônico. Com
 * chave, quem só vê `•••• NNNN` não testa hipóteses do número completo (um
 * hash simples permitiria, com 10^7 tentativas).
 */
export function audienceKey(input: AudienceKeyInput, secret: Buffer): string {
  if (secret.length === 0) {
    throw new Error('Chave vazia: impressão do público sem chave');
  }
  return createHmac('sha256', secret)
    .update(canonicalAudience(input))
    .digest('hex');
}
