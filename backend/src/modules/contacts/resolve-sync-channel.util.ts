import type { Channel, ChannelProvider } from '@prisma/client';
import { isSessionProvider } from '../../schemas/contracts/channel-provider.schema';
import { SyncNotSupportedError } from './errors/contacts.errors';

/** The three collaborators `resolveSyncChannel` needs, kept narrow (`Pick`)
 * so both callers (the HTTP-time service and the queue processor) can pass
 * their own already-injected instances without adapting anything. */
type InstancesRepoLike = { listActive(): Promise<Channel[]> };
type ProvidersServiceLike = {
  supportsNumberCheckFor(provider: ChannelProvider): boolean;
};
type ContactsRepoLike = {
  isSessionChannelOnline(channel: {
    id: string;
    provider: string;
  }): Promise<boolean>;
};

/**
 * Fix round 1 (revisão pós-commit) — `WhatsappInstancesRepository.findDefault()`
 * SEM `provider` devolve o `isDefault` mais VELHO entre TODOS os provedores
 * (comentário do próprio método), porque `setDefault` é escopado POR
 * PROVEDOR (T8): pode haver um default EVOLUTION e um default GOZAP ao mesmo
 * tempo, e o mais velho não é necessariamente o vivo. Em produção isto podia
 * eleger uma linha EVOLUTION de teste, morta, em vez do GOZAP que
 * efetivamente está online — a validação ativa consultaria uma instância
 * morta e recusaria (ou pior, silenciosamente não faria nada).
 *
 * A escolha correta é entre TODOS os canais ATIVOS e DEFAULT (um por
 * provedor, no máximo) cujo adapter sabe validar número — e, havendo mais de
 * um, prefere quem está de SESSÃO e ONLINE agora (quem pode validar de
 * verdade neste instante). Um candidato ÚNICO é devolvido mesmo que esteja
 * offline: não há entre quem escolher, e o chamador já faz o SEU PRÓPRIO
 * `isSessionChannelOnline` logo em seguida — duplicar a checagem aqui só
 * faria a mesma recusa acontecer em dois lugares com duas mensagens.
 *
 * Usado por `ContactsService.syncBackfill` (recusa no clique) e
 * `ContactSyncProcessor.process` (recusa/pula no job) — o MESMO resolver,
 * para que os dois nunca escolham canais diferentes para a mesma pergunta.
 */
export async function resolveSyncChannel(
  instancesRepo: InstancesRepoLike,
  wa: ProvidersServiceLike,
  contactsRepo: ContactsRepoLike,
): Promise<Channel> {
  const active = await instancesRepo.listActive();
  const candidates = active.filter(
    (c) => c.isDefault && wa.supportsNumberCheckFor(c.provider),
  );
  if (candidates.length === 0) {
    throw new SyncNotSupportedError(
      'no active default channel supports checkNumbersOnWhatsapp',
    );
  }
  if (candidates.length === 1) return candidates[0];

  // Vários candidatos: prefira quem está de SESSÃO e ONLINE — um oficial
  // (Twilio/Zernio/Meta) é sempre "online" pelo mesmo predicado (sem sessão
  // para cair), então só entra depois, e só se ninguém de sessão estiver de
  // pé.
  const online: Channel[] = [];
  for (const c of candidates) {
    if (await contactsRepo.isSessionChannelOnline(c)) online.push(c);
  }
  const onlineSession = online.find((c) => isSessionProvider(c.provider));
  if (onlineSession) return onlineSession;
  if (online.length > 0) return online[0];

  // Ninguém está online — devolve o primeiro de forma DETERMINÍSTICA (a
  // ordem de `listActive()`: isDefault desc, createdAt asc), para que o gate
  // de online JÁ EXISTENTE do chamador produza o erro específico daquele
  // canal, em vez de um "nenhum canal" genérico.
  return candidates[0];
}
