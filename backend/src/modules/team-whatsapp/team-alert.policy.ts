import type { TeamPurpose } from '../../schemas/contracts/team-whatsapp.schema';
import {
  hasPermission,
  permissionDenied,
} from '../../shared/authz/permissions';
import type { TeamActor } from './team-whatsapp.policy';

/**
 * Portão da chave `equipe.urgencia` (I1/DI2). Só lê o ator: na prévia e na
 * criação vem depois de `requireSender` e antes de qualquer leitura de setores
 * ou pessoas (GI4). A rota é a mesma das outras finalidades, então a checagem é
 * por finalidade, aqui no servidor.
 */
export function requireUrgencyFor(
  actor: TeamActor,
  purpose: TeamPurpose | undefined,
): void {
  if (purpose === 'urgency') requireUrgencyKey(actor);
}

/** Incondicional: lembrete e ciência manual só existem em alerta urgente. */
export function requireUrgencyKey(actor: TeamActor): void {
  if (!hasPermission(actor, 'equipe.urgencia')) {
    throw permissionDenied('equipe.urgencia');
  }
}
