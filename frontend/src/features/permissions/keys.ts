// Espelho de backend/src/shared/authz/permissions.ts (CB2): mesma ordem e a mesma
// matriz inicial. O front só esconde; quem decide é a API.

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

export type UserRole = 'ADMIN' | 'SUPERVISOR' | 'OPERATOR' | 'VIEWER';

/**
 * Matriz inicial: ADMIN e VIEWER são fixos (todas / nenhuma) e não passam por ela.
 * SUPERVISOR e OPERATOR listam as chaves uma a uma: chave nova nasce desmarcada
 * (`pessoas.exportar` é só do administrador até alguém conceder).
 */
const DEFAULT_MATRIX = {
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
} as const satisfies Record<string, readonly PermissionKey[]>;

/** Permissões de quem ainda não recebeu a lista da API (sessão persistida antiga). */
export const DEFAULT_PERMISSIONS: Record<UserRole, readonly PermissionKey[]> = {
  ADMIN: PERMISSION_KEYS,
  VIEWER: [],
  ...DEFAULT_MATRIX,
};

export const PERMISSION_LABELS: Record<PermissionKey, { name: string; description: string }> = {
  'pessoas.editar': {
    name: 'Cadastrar e editar pessoas',
    description: 'Cadastrar, editar, mover e tirar pessoas nos setores que gerencia.',
  },
  'pessoas.inativar': {
    name: 'Inativar e reativar pessoas',
    description:
      'Só pessoas sem acesso ao sistema, nos setores que gerencia. Quem tem acesso, só o administrador.',
  },
  'escala.alterar': {
    name: 'Alterar a escala',
    description: 'Mudar a escala e as exceções nos setores que gerencia.',
  },
  'estrutura.manter': {
    name: 'Manter setores, turnos e níveis',
    description: 'Criar e editar setores, turnos e níveis.',
  },
  'telefone.ver_completo': {
    name: 'Ver o telefone completo',
    description: 'Sem esta permissão, aparecem só os 4 últimos dígitos.',
  },
  'equipe.enviar': {
    name: 'Enviar WhatsApp à equipe',
    description: 'Enviar, agendar, cancelar e repetir envios nos setores que gerencia.',
  },
  'equipe.disparo_amplo': {
    name: 'Enviar a todos os setores de uma vez',
    description: 'Envio que cobre todos os setores ativos da empresa.',
  },
  'trilha.consultar': {
    name: 'Consultar o histórico das pessoas',
    description:
      'Ver o histórico de alterações das pessoas dos setores que gerencia. A trilha completa é só do administrador.',
  },
  'pessoas.exportar': {
    name: 'Exportar pessoas e escala',
    description:
      'Baixar a lista de pessoas e a escala em CSV ou XLSX. Quem não é administrador exporta só os setores que gerencia.',
  },
};

/**
 * Mantém só as chaves conhecidas, na ordem de PERMISSION_KEYS (DB19): um back
 * mais novo pode mandar chave que esta aba ainda não conhece, sem quebrá-la.
 */
export function toPermissionKeys(raw: readonly string[]): PermissionKey[] {
  return PERMISSION_KEYS.filter((key) => raw.includes(key));
}
