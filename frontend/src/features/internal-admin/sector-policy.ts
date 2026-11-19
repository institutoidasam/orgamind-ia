import type { UserRole } from '@/features/users/role';

/**
 * DB20 (provisória, a confirmar com a GBR): escolher ou trocar o gestor do setor
 * continua só do ADMIN, mesmo com `estrutura.manter`. Decisão de tela, só para
 * esconder o campo — a API devolve 403 `sector.manager_admin_only` de verdade.
 */
export function canSetSectorManagerUi(role?: UserRole): boolean {
  return role === 'ADMIN';
}
