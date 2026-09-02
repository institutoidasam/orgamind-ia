// C5 — auditoria da base: classifica os ~13.000 contatos em coortes de
// PROCEDÊNCIA (spec §6.2) e grava `Contact.sourceOrigin` + `lastInteractionAt`.
//
// Uso (container do backend, Dokploy):
//   npx tsx scripts/classify-source-origin.ts
//   npx tsx scripts/classify-source-origin.ts --batch-size 1000
//
// A rotina NÃO ENVIA NADA e NÃO ESCREVE CONSENTIMENTO — é leitura dos sinais que
// já existem no banco (lote de importação, histórico de conversa, checagem de
// WhatsApp) projetada em duas colunas. É idempotente: rodar de novo não muda
// nada e não reescreve linha nenhuma (a 2ª passada emite ZERO UPDATEs).
//
// É o passo que a spec manda executar ANTES de tocar em qualquer botão de envio:
// o objetivo não é "converter 13k", é descobrir o que a base realmente é.

import { PrismaService } from '../src/shared/prisma/prisma.service';
import {
  SourceOriginService,
  type ClassifyReport,
} from '../src/modules/consent/source-origin.service';

const COORTE_LABEL: Record<string, string> = {
  INTERAGIU: 'C1  INTERAGIU (relação demonstrável — NÃO é consentimento)',
  DOCUMENTADA_COM_DECLARACAO: 'C2  ORIGEM DOCUMENTADA COM DECLARAÇÃO',
  DOCUMENTADA_SEM_DECLARACAO: 'C3  ORIGEM DOCUMENTADA SEM DECLARAÇÃO',
  DESCONHECIDA: 'C4  PROCEDÊNCIA DESCONHECIDA (não enviar nada)',
  INVALIDO_NAO_WHATSAPP: 'C5  INVÁLIDO / NÃO-WHATSAPP',
};

export function formatReport(report: ClassifyReport): string {
  const pct = (n: number) =>
    report.scanned ? `${((n / report.scanned) * 100).toFixed(1)}%` : '0.0%';

  const lines = [
    `Auditoria de procedência — ${report.scanned} contatos`,
    `  atualizados: ${report.updated}   já corretos: ${report.unchanged}`,
    '',
  ];
  for (const [origin, label] of Object.entries(COORTE_LABEL)) {
    const n = report.byOrigin[origin as keyof typeof report.byOrigin] ?? 0;
    lines.push(`  ${label.padEnd(52)} ${String(n).padStart(6)}  (${pct(n)})`);
  }
  lines.push(
    '',
    'Nenhuma mensagem foi enviada e nenhum consentimento foi gravado.',
    'C2 é candidata a backfill de GRANT (IMPORT_LEGACY) — passo separado e auditado.',
  );
  return `${lines.join('\n')}\n`;
}

function parseBatchSize(argv: string[]): number | undefined {
  const i = argv.indexOf('--batch-size');
  if (i === -1) return undefined;
  const n = Number(argv[i + 1]);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const prisma = new PrismaService();
  const service = new SourceOriginService(prisma);
  const batchSize = parseBatchSize(process.argv);

  service
    .classifyAll(batchSize ? { batchSize } : undefined)
    .then((report) => process.stdout.write(formatReport(report)))
    .catch((e: unknown) => {
      process.stderr.write(
        `classify-source-origin falhou: ${String(e instanceof Error ? (e.stack ?? e.message) : e)}\n`,
      );
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
