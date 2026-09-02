import { PrismaClient } from '@prisma/client';
import { maskPhonesInLog } from './merge-duplicate-phone-contacts';
import { DELIVERY_PROVEN_STATUSES } from '../src/shared/contact-validity';

const prisma = new PrismaClient();

/**
 * BACKFILL PASSIVO DE VALIDADE (spec 2026-08-24, B.2) — idempotente.
 *
 * O cliente diz "não verificados" e está certo: desde a saída da Evolution
 * NADA valida número em produção (o canal é GoZap, e `checkNumbersOnWhatsapp`
 * só existia no adapter Evolution). Mas o sistema JÁ SABE quem é válido: quem
 * recebeu. Uma mensagem OUTBOUND que chegou a DELIVERED/READ é prova de que o
 * número existe no WhatsApp — prova melhor, aliás, do que uma consulta de
 * existência, e de graça.
 *
 * Os status que provam entrega (`DELIVERY_PROVEN_STATUSES` — por que `SENT`
 * fica de fora) são os de `../src/shared/contact-validity` (spec B.1): a
 * MESMA definição usada pelos filtros de válido/inválido, não uma cópia.
 *
 *   npx tsx prisma/backfill-contact-validity.ts            # dry-run (padrão)
 *   npx tsx prisma/backfill-contact-validity.ts --apply    # para valer
 *
 * NÃO É DESTRUTIVO: só escreve dado DERIVADO (`whatsappValid`/
 * `whatsappCheckedAt`) em linhas que estão NULL, e nunca apaga nada. Por isso
 * entra no `migrate` do compose no balde dos `|| echo … continuing`, ao lado
 * de `repair-campaign-message-content` e `backfill-conversations` — e NÃO no
 * `&&` fatal, reservado a `merge-duplicate-phone-contacts`, que apaga linha.
 */
const BATCH_CAP = 100_000;

export async function backfillContactValidity(
  db: PrismaClient = prisma,
  opts: { apply: boolean } = { apply: false },
): Promise<{ candidates: number; updated: number; samples: string[] }> {
  const rows = await db.contact.findMany({
    where: {
      whatsappValid: null,
      messages: {
        some: { direction: 'OUTBOUND', status: { in: DELIVERY_PROVEN_STATUSES } },
      },
    },
    select: { id: true, phoneE164: true },
    take: BATCH_CAP,
  });

  const samples = rows.slice(0, 10).map((r) => `${r.phoneE164} [${r.id}]`);
  if (!opts.apply || rows.length === 0) {
    return { candidates: rows.length, updated: 0, samples };
  }

  // `whatsappValid: null` REPETIDO no update, e não só no select acima: entre
  // as duas queries um envio pode ter marcado a linha como `false`. Sem esta
  // guarda o backfill ressuscitaria um inválido CONFIRMADO como válido — e o
  // operador voltaria a discar um número que o WhatsApp já recusou.
  const result = await db.contact.updateMany({
    where: { id: { in: rows.map((r) => r.id) }, whatsappValid: null },
    data: { whatsappValid: true, whatsappCheckedAt: new Date() },
  });

  return { candidates: rows.length, updated: result.count, samples };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const apply = process.argv.includes('--apply');

  (async () => {
    // VÁLVULA DE ESCAPE, no mesmo molde de MERGE_DUPLICATE_CONTACTS: destrava a
    // subida sem editar o compose, e diz em voz alta que o reparo NÃO rodou.
    if (process.env.CONTACT_VALIDITY_BACKFILL === 'skip') {
      console.log(
        '⏭️  CONTACT_VALIDITY_BACKFILL=skip — o backfill de validade NÃO rodou neste deploy. Enquanto isso ficar ligado, quem já recebeu continua aparecendo como "Não validado" na lista e no filtro.',
      );
      return;
    }

    const r = await backfillContactValidity(prisma, { apply });
    console.log(
      apply
        ? '=== BACKFILL DE VALIDADE APLICADO ==='
        : '=== DRY-RUN (nada foi escrito; use --apply para valer) ===',
    );
    console.log(`candidatos (entrega provada, ainda NULL) ... ${r.candidates}`);
    console.log(`marcados como válidos ..................... ${r.updated}`);
    // O telefone do eleitor NÃO vai inteiro para o log do deploy: o stdout
    // deste contêiner é o que a API do Dokploy expõe. Mesma regra (e mesma
    // função) de merge-duplicate-phone-contacts.
    for (const s of r.samples) {
      console.log(`  ${maskPhonesInLog(s)}`);
    }
  })()
    .catch((e) => {
      console.error(e);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
}
