import type { PrismaService } from '../../shared/prisma/prisma.service';
import type { InboundUpdate } from './conversation-inbound';

/**
 * Dublê de `applyInboundUpdate` para os specs UNITÁRIOS da ingestão, cujo Prisma
 * falso não tem `$transaction`: faz o mesmo `conversation.update` de antes da
 * K1 e nunca reabre. A regra real (trava da linha, reabertura, histórico) tem o
 * spec de integração com banco (`conversation-inbound.integration.spec.ts`).
 *
 * Uso: `vi.mock('./conversation-inbound', () => vi.importActual('./conversation-inbound.test-fixtures'));`
 */
export async function applyInboundUpdate(
  prisma: PrismaService,
  args: InboundUpdate,
): Promise<{ reopened: boolean }> {
  await prisma.conversation.update({
    where: { id: args.conversationId },
    data: args.data,
  });
  return { reopened: false };
}
