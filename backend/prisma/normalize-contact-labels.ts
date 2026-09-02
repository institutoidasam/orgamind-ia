import { PrismaClient } from '@prisma/client';
import { maskPhonesInLog } from './merge-duplicate-phone-contacts';

const prisma = new PrismaClient();

/**
 * NORMALIZAÇÃO RETROATIVA DE CIDADE/GRUPO/TAGS (spec 2026-08-25, §2.2) —
 * idempotente. O combobox do formulário (frontend/src/features/contacts/
 * lib/normalize-label.ts) impede duplicata NOVA a partir de agora; este
 * script fecha a lacuna das que JÁ EXISTEM no banco — o sintoma relatado
 * pelo cliente ("se cadastrar Manaus e manaus são 2 registros diferentes"),
 * que só desaparece de verdade quando as linhas antigas são reescritas.
 *
 *   npx tsx prisma/normalize-contact-labels.ts            # dry-run (padrão)
 *   npx tsx prisma/normalize-contact-labels.ts --apply    # para valer
 *
 * NÃO É DESTRUTIVO: só reescreve city/group/elementos de tags para um
 * rótulo que JÁ EXISTIA na base (nunca inventa forma canônica que ninguém
 * digitou) e nunca apaga contato nem mensagem.
 *
 * ⚠️ Ao contrário de backfill-contact-validity.ts e
 * merge-duplicate-phone-contacts.ts, este script NÃO está encadeado no
 * docker-compose.prod.yml. A eleição de rótulo canônico troca um dado que o
 * operador VÊ e USA para segmentar campanhas — precisa de revisão humana do
 * dry-run antes de qualquer --apply em produção.
 */
const BATCH_CAP = 100_000;

/**
 * Cópia deliberada de frontend/src/features/contacts/lib/normalize-label.ts
 * — backend e frontend não compartilham módulo (mesmo padrão de
 * consent-text.composer.ts, source-origin.classifier.ts e
 * whatsapp-instances.service.ts#slugify, que reimplementam a mesma faixa
 * NFD cada um no seu lugar). Divergir aqui faria o backend "corrigir" para
 * uma chave diferente da que o formulário usa para reconhecer duplicata
 * nova. A faixa `̀-ͯ` é a mesma usada por
 * whatsapp-instances.service.ts#slugify — marcas diacríticas combinantes
 * que sobram depois do `normalize('NFD')`.
 */
export function normalizeForCompare(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase('pt-BR');
}

type Candidate = { label: string; count: number; oldestCreatedAt: Date };

/**
 * QUEM VENCE dentro de um cluster de variantes do MESMO valor normalizado:
 * 1) mais frequente; 2) empate → mais antigo (Contact.createdAt); 3) empate
 * total → ordem alfabética pt-BR (só para o resultado ser determinístico e
 * reproduzível entre o dry-run e o --apply que o segue).
 */
export function electCanonicalLabel(candidates: readonly Candidate[]): string {
  const sorted = [...candidates].sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    const age = a.oldestCreatedAt.getTime() - b.oldestCreatedAt.getTime();
    if (age !== 0) return age;
    return a.label.localeCompare(b.label, 'pt-BR');
  });
  return sorted[0].label;
}

export type LabelCluster = {
  normalizedKey: string;
  canonical: string;
  variants: { label: string; count: number }[];
  /** Quantos contatos SERIAM/FORAM atualizados neste cluster. */
  contactsAffected: number;
};

/**
 * Agrupa (label, createdAt) em clusters por chave normalizada — só os
 * clusters com MAIS DE UMA variante entram no relatório (um valor sozinho
 * já está certo, não é duplicata).
 */
function buildClusters(rows: { label: string; createdAt: Date }[]): LabelCluster[] {
  const byKey = new Map<string, Map<string, { count: number; oldest: Date }>>();
  for (const { label, createdAt } of rows) {
    const key = normalizeForCompare(label);
    let variants = byKey.get(key);
    if (!variants) {
      variants = new Map();
      byKey.set(key, variants);
    }
    const entry = variants.get(label);
    if (entry) {
      entry.count += 1;
      if (createdAt < entry.oldest) entry.oldest = createdAt;
    } else {
      variants.set(label, { count: 1, oldest: createdAt });
    }
  }

  const clusters: LabelCluster[] = [];
  for (const [normalizedKey, variants] of byKey) {
    if (variants.size < 2) continue; // já é um valor só — nada a fazer
    const candidates: Candidate[] = [...variants.entries()].map(([label, v]) => ({
      label,
      count: v.count,
      oldestCreatedAt: v.oldest,
    }));
    const canonical = electCanonicalLabel(candidates);
    const contactsAffected = candidates
      .filter((c) => c.label !== canonical)
      .reduce((sum, c) => sum + c.count, 0);
    clusters.push({
      normalizedKey,
      canonical,
      variants: candidates.map((c) => ({ label: c.label, count: c.count })),
      contactsAffected,
    });
  }
  return clusters.sort((a, b) => b.contactsAffected - a.contactsAffected);
}

/**
 * Campo ESCALAR (city/group): um `updateMany` por rótulo perdedor cobre
 * todos os contatos que o têm — não precisa reconstruir nada por contato.
 */
async function normalizeScalarField(
  db: PrismaClient,
  field: 'city' | 'group',
  apply: boolean,
): Promise<{ clusters: LabelCluster[]; contactsUpdated: number }> {
  const rows = await db.contact.findMany({
    where: { [field]: { not: null } } as never,
    select: { [field]: true, createdAt: true } as never,
    take: BATCH_CAP,
  });
  const clusters = buildClusters(
    (rows as { createdAt: Date }[]).map((r) => ({
      label: (r as never)[field] as string,
      createdAt: r.createdAt,
    })),
  );

  let contactsUpdated = 0;
  if (apply) {
    for (const cluster of clusters) {
      for (const variant of cluster.variants) {
        if (variant.label === cluster.canonical) continue;
        const result = await db.contact.updateMany({
          where: { [field]: variant.label } as never,
          data: { [field]: cluster.canonical } as never,
        });
        contactsUpdated += result.count;
      }
    }
  } else {
    contactsUpdated = clusters.reduce((sum, c) => sum + c.contactsAffected, 0);
  }

  return { clusters, contactsUpdated };
}

/**
 * Campo LISTA (tags): dois contatos podem compartilhar uma tag e divergir
 * no resto do array, então a fusão reconstrói o array inteiro de cada
 * contato afetado, remove a duplicata exata que a canonicalização cria
 * (['vip', 'VIP'] → ['vip', 'vip'] → ['vip']), e só grava quando o
 * resultado realmente muda.
 */
async function normalizeTags(
  db: PrismaClient,
  apply: boolean,
): Promise<{ clusters: LabelCluster[]; contactsUpdated: number }> {
  const rows = await db.contact.findMany({
    where: { tags: { isEmpty: false } },
    select: { id: true, tags: true, createdAt: true },
    take: BATCH_CAP,
  });

  const flat: { label: string; createdAt: Date }[] = [];
  for (const r of rows) {
    for (const tag of r.tags) flat.push({ label: tag, createdAt: r.createdAt });
  }
  const clusters = buildClusters(flat);
  const canonicalByNormalized = new Map(clusters.map((c) => [c.normalizedKey, c.canonical]));

  let contactsUpdated = 0;
  for (const r of rows) {
    const nextTags: string[] = [];
    for (const tag of r.tags) {
      const canonical = canonicalByNormalized.get(normalizeForCompare(tag)) ?? tag;
      if (!nextTags.includes(canonical)) nextTags.push(canonical);
    }
    const changed =
      nextTags.length !== r.tags.length || nextTags.some((t, i) => t !== r.tags[i]);
    if (!changed) continue;

    contactsUpdated += 1;
    if (apply) {
      await db.contact.update({ where: { id: r.id }, data: { tags: nextTags } });
    }
  }

  return { clusters, contactsUpdated };
}

export type NormalizeReport = {
  apply: boolean;
  city: { clusters: LabelCluster[]; contactsUpdated: number };
  group: { clusters: LabelCluster[]; contactsUpdated: number };
  tags: { clusters: LabelCluster[]; contactsUpdated: number };
};

export async function normalizeContactLabels(
  db: PrismaClient = prisma,
  opts: { apply: boolean } = { apply: false },
): Promise<NormalizeReport> {
  const city = await normalizeScalarField(db, 'city', opts.apply);
  const group = await normalizeScalarField(db, 'group', opts.apply);
  const tags = await normalizeTags(db, opts.apply);
  return { apply: opts.apply, city, group, tags };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const apply = process.argv.includes('--apply');

  (async () => {
    // VÁLVULA DE ESCAPE, no mesmo molde de CONTACT_VALIDITY_BACKFILL/
    // MERGE_DUPLICATE_CONTACTS: destrava a subida sem editar o compose, e
    // diz em voz alta que o reparo NÃO rodou. (Este script não está
    // encadeado no compose hoje — a env fica pronta para quando estiver.)
    if (process.env.NORMALIZE_CONTACT_LABELS === 'skip') {
      console.log(
        '⏭️  NORMALIZE_CONTACT_LABELS=skip — a normalização retroativa de cidade/grupo/tags NÃO rodou neste deploy.',
      );
      return;
    }

    const r = await normalizeContactLabels(prisma, { apply });
    console.log(
      apply
        ? '=== NORMALIZAÇÃO APLICADA ==='
        : '=== DRY-RUN (nada foi escrito; use --apply para valer) ===',
    );
    for (const [name, part] of [
      ['cidade', r.city],
      ['grupo', r.group],
      ['tags', r.tags],
    ] as const) {
      console.log(
        `--- ${name}: ${part.clusters.length} grupo(s) de duplicata, ${part.contactsUpdated} contato(s) ${apply ? 'atualizados' : 'seriam atualizados'} ---`,
      );
      for (const c of part.clusters) {
        // Nota de PII: só rótulo (cidade/grupo/tag) + contagem — nunca
        // phoneE164 nem Contact.id amarrado a um rótulo específico.
        // Cidade/grupo/tag não identificam uma pessoa isoladamente, ao
        // contrário do telefone (maskPhonesInLog existe para o dia em que
        // alguém colar um telefone aqui por engano; não é usado hoje).
        const variantsStr = c.variants.map((v) => `"${v.label}"(${v.count})`).join(' + ');
        console.log(maskPhonesInLog(`  ${variantsStr} → "${c.canonical}"`));
      }
    }
  })()
    .catch((e) => {
      console.error(e);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
}
