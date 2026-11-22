import type { ConsentService } from '../consent/consent.service';
import type { TeamMember } from './team-whatsapp.repository';

/** Pulo de telefone (C8/DF3): o destinatário fica `SKIPPED` e, na prévia, excluído. */
export type PhoneSkipReason = 'NO_PHONE' | 'SUPPRESSED' | 'NOT_AUTHORIZED';

/**
 * Telefone que o envio usa: o contato carrega a grafia que o merge elegeu como
 * a que entrega; sem contato ligado, o do usuário. Completo: nunca sai na API
 * sem `phoneView`.
 */
export function sendPhoneOf(
  m: Pick<TeamMember, 'contact' | 'phoneE164'>,
): string | null {
  return m.contact?.phoneE164 ?? m.phoneE164 ?? null;
}

/**
 * Ordem C8: sem telefone → supressão → sem autorização de contato. A supressão
 * (pedido de saída) vale por cima; `CADASTRO_ANTERIOR` autorizado não bloqueia.
 */
export async function phoneSkipReason(
  m: Pick<TeamMember, 'contact' | 'phoneE164' | 'contactAuthorization'>,
  consent: Pick<ConsentService, 'isSuppressed'>,
): Promise<PhoneSkipReason | null> {
  const phone = sendPhoneOf(m);
  if (!phone) return 'NO_PHONE';
  if (await consent.isSuppressed(phone)) return 'SUPPRESSED';
  return m.contactAuthorization === 'AUTORIZADO' ? null : 'NOT_AUTHORIZED';
}
