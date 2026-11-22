import type { CreateTeamDispatchInput } from './dto/create-team-dispatch.dto';
import { DomainError } from '../../shared/errors/domain.error';
import { teamForbidden } from './team-whatsapp.errors';
import type { Harness } from './team-whatsapp.test-fixtures';

/** Chave provisória: o envio que falha antes da impressão lança o erro de regra sem compará-la (GF9). */
const NO_KEY = '0'.repeat(64);

/** Só a recusa de domínio do público (403/409/422) vira a chave de zeros; o resto (TypeError…) sobe. */
const isAudienceRefusal = (error: unknown): boolean =>
  error instanceof DomainError && [403, 409, 422].includes(error.status);

/**
 * Envio para setor no corpo novo (CF2) para os specs do serviço (não é spec:
 * não roda sozinho). Alvo pessoa volta igual. Alvo setor leva a finalidade
 * (padrão Aviso de turno) e a impressão que o público real (`h.audience`)
 * dá para o corpo, com os fakes do cenário já montados: chame depois de
 * montá-los e, se o teste os muda entre a prévia e o envio, antes da mudança.
 *
 * Com `expectError`, o teste espera 403/422 do público: o corpo volta com a
 * chave de zeros e o envio lança o mesmo erro antes de comparar a impressão.
 * Sem `expectError`, o erro do público é relançado, para um teste de sucesso
 * que caia numa regra nova falhar alto.
 */
export async function withAudienceKey(
  h: Harness,
  actorId: string,
  input: CreateTeamDispatchInput,
  opts: { expectError?: boolean } = {},
): Promise<CreateTeamDispatchInput> {
  if (input.target.type === 'user') return input;
  const body = { ...input, purpose: input.purpose ?? 'shift_notice' };
  try {
    const actor = await h.repo.findActor(actorId);
    if (!actor) throw teamForbidden();
    const resolved = await h.audience.resolve(actor, {
      ...body,
      target: input.target,
    });
    return { ...body, audienceKey: resolved.audienceKey };
  } catch (error) {
    if (opts.expectError && isAudienceRefusal(error))
      return { ...body, audienceKey: NO_KEY };
    throw error;
  }
}
