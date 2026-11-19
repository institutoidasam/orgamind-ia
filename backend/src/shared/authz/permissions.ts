import type { Role } from '@prisma/client';
import { DomainError } from '../errors/domain.error';

/**
 * Permissões por ação (spec B1/B2, CB2). Regras puras, sem banco: ADMIN tem
 * todas e VIEWER nenhuma, sempre; SUPERVISOR e OPERATOR seguem a matriz
 * editável (`RolePermission`), e linha ausente vale a matriz inicial. Uma chave
 * só entra aqui na etapa em que a função existe.
 */
export const PERMISSION_KEYS = [
  'pessoas.editar',
  'pessoas.inativar',
  'escala.alterar',
  'estrutura.manter',
  'telefone.ver_completo',
  'equipe.enviar',
  'equipe.disparo_amplo',
  'trilha.consultar',
  'pessoas.exportar',
] as const;
export type PermissionKey = (typeof PERMISSION_KEYS)[number];

export const EDITABLE_ROLES = ['SUPERVISOR', 'OPERATOR'] as const;
export type EditableRole = (typeof EDITABLE_ROLES)[number];

/**
 * Matriz inicial (spec B2). ADMIN e VIEWER não entram: são fixos. A lista do
 * SUPERVISOR é explícita: chave nova não chega a ele por padrão, só por
 * decisão registrada aqui e na migração que a semeia.
 */
export const DEFAULT_MATRIX: Readonly<
  Record<EditableRole, readonly PermissionKey[]>
> = {
  SUPERVISOR: [
    'pessoas.editar',
    'pessoas.inativar',
    'escala.alterar',
    'telefone.ver_completo',
    'equipe.enviar',
    'equipe.disparo_amplo',
    'trilha.consultar',
  ],
  OPERATOR: [
    'pessoas.editar',
    'escala.alterar',
    'telefone.ver_completo',
    'equipe.enviar',
    'equipe.disparo_amplo',
  ],
};

export function isPermissionKey(value: string): value is PermissionKey {
  return (PERMISSION_KEYS as readonly string[]).includes(value);
}

export function isEditableRole(role: Role): role is EditableRole {
  return (EDITABLE_ROLES as readonly Role[]).includes(role);
}

/** ADMIN todas; VIEWER nenhuma; SUPERVISOR e OPERATOR a matriz inicial. */
export function defaultPermissionsFor(role: Role): PermissionKey[] {
  if (role === 'ADMIN') return [...PERMISSION_KEYS];
  if (!isEditableRole(role)) return [];
  const granted = DEFAULT_MATRIX[role];
  return PERMISSION_KEYS.filter((key) => granted.includes(key));
}

/**
 * Permissões efetivas do papel. ADMIN e VIEWER ignoram `rows`; nos demais a
 * linha vence o padrão, a chave ausente cai no padrão e a desconhecida (de
 * etapa futura ou lixo) é ignorada. Saída na ordem de `PERMISSION_KEYS`.
 */
export function resolvePermissions(
  role: Role,
  rows: ReadonlyArray<{ key: string; granted: boolean }>,
): PermissionKey[] {
  if (!isEditableRole(role)) return defaultPermissionsFor(role);
  const stored = new Map<string, boolean>(
    rows.map((row) => [row.key, row.granted]),
  );
  const defaults = DEFAULT_MATRIX[role];
  return PERMISSION_KEYS.filter(
    (key) => stored.get(key) ?? defaults.includes(key),
  );
}

export type PermissionHolder = { permissions: readonly PermissionKey[] };

export function hasPermission(
  holder: PermissionHolder,
  key: PermissionKey,
): boolean {
  return holder.permissions.includes(key);
}

/** Texto do 403 por chave (CB8): o que a pessoa não pode fazer, em linguagem do usuário. */
export const PERMISSION_DENIED_TEXT: Readonly<Record<PermissionKey, string>> = {
  'pessoas.editar': 'Você não tem permissão para cadastrar ou editar pessoas.',
  'pessoas.inativar':
    'Você não tem permissão para inativar ou reativar pessoas.',
  'escala.alterar': 'Você não tem permissão para alterar a escala.',
  'estrutura.manter':
    'Você não tem permissão para manter setores, turnos e níveis.',
  'telefone.ver_completo':
    'Você não tem permissão para ver ou alterar o telefone completo.',
  'equipe.enviar': 'Você não tem permissão para enviar WhatsApp à equipe.',
  'equipe.disparo_amplo':
    'Você não tem permissão para enviar a todos os setores de uma vez.',
  'trilha.consultar':
    'Você não tem permissão para consultar o histórico de alterações.',
  'pessoas.exportar': 'Você não tem permissão para exportar pessoas e escala.',
};

export function permissionDenied(key: PermissionKey): DomainError {
  return new DomainError({
    code: 'auth.permission_denied',
    status: 403,
    message: 'Ação não permitida',
    detail: PERMISSION_DENIED_TEXT[key],
  });
}
