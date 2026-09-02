import { Injectable, Logger } from '@nestjs/common';
import type { Writable } from 'node:stream';
import * as ExcelJS from 'exceljs';
import {
  ContactsRepository,
  buildContactListWhere,
  type ContactExportRow,
} from './contacts.repository';
import { AuditService } from '../../shared/audit/audit.service';
import { ValidationError } from '../../shared/errors/domain.error';
import {
  CONTACT_VALIDITY_LABELS,
  classifyContactValidity,
} from '../../shared/contact-validity';
import { FAILURE_REASON_LABELS } from '../campaigns/failure-reason';
import { TIMEZONE_DEFAULT } from '../../schemas/contracts/schedule.schema';
import type { ExportContactsQuery } from '../../schemas/contracts/contact.schema';

/**
 * O TETO. Não é performance: é VAZAMENTO. Uma planilha com a base inteira de
 * uma campanha eleitoral é o pior arquivo que pode sair daqui por acidente
 * (art. 6º, LGPD — necessidade). Acima do teto, o operador precisa dizer QUAL
 * recorte quer, e é a mensagem de erro que ensina isso.
 */
export const CONTACT_EXPORT_ROW_CAP = 50_000;

/** Linhas por query. Alto o bastante para poucas idas ao banco, baixo o
 *  bastante para nunca segurar a base inteira em memória. */
export const CONTACT_EXPORT_PAGE_SIZE = 500;

export const CONTACT_EXPORT_HEADERS = [
  'Telefone',
  'Nome',
  'Cidade',
  'Grupo',
  'Tags',
  'Situação',
  'Motivo',
  'Última tentativa',
] as const;

/**
 * Para onde o .xlsx é escrito. É o `res` do Express em produção (que estende
 * `stream.Writable` e tem `setHeader`/`headersSent`/`removeHeader`), e um
 * `PassThrough` no teste — o serviço não precisa saber qual dos dois.
 * `headersSent` é o que decide, se der erro NO MEIO do streaming, entre
 * relançar (ninguém ainda viu nada — o filtro global responde normalmente) e
 * derrubar a conexão (o cliente já está recebendo bytes — não dá mais para
 * responder com um status de erro, só para parar de mentir que está tudo
 * bem). `removeHeader` é o que desfaz o `Content-Disposition: attachment`
 * quando o erro chega ANTES dos headers saírem de verdade — sem isso, o
 * corpo JSON do erro sairia disfarçado de planilha para o navegador.
 */
export type XlsxSink = Writable & {
  setHeader(name: string, value: string): void;
  removeHeader(name: string): void;
  headersSent: boolean;
};

const DATE_FORMAT = new Intl.DateTimeFormat('pt-BR', {
  timeZone: TIMEZONE_DEFAULT,
  dateStyle: 'short',
  timeStyle: 'short',
});

/**
 * As 8 colunas, em PT-BR, para o OPERADOR — e para quem vai receber a planilha
 * de volta (o cliente devolve inválidos a quem passou os contatos). Nenhum
 * slug de enum sai daqui.
 *
 * "Última tentativa" é a EVIDÊNCIA MAIS RECENTE que temos sobre o número:
 * a última falha definitiva quando houve uma, senão a última checagem. Sem
 * esse fallback, um número marcado inválido por checagem ativa sairia sem data
 * nenhuma e pareceria um dado faltando.
 */
export function toExportRow(c: ContactExportRow): (string | null)[] {
  const validity = classifyContactValidity({
    whatsappValid: c.whatsappValid,
    lastFailureReason: c.lastFailureReason,
    hasProvenDelivery: c.messages.length > 0,
  });
  const lastAttempt = c.lastFailureAt ?? c.whatsappCheckedAt;
  return [
    c.phoneE164,
    c.name ?? '',
    c.city ?? '',
    c.group ?? '',
    c.tags.join(', '),
    CONTACT_VALIDITY_LABELS[validity],
    c.lastFailureReason ? FAILURE_REASON_LABELS[c.lastFailureReason] : '',
    lastAttempt ? DATE_FORMAT.format(lastAttempt) : '',
  ];
}

/**
 * Review fix (round 1, finding #4) — `search` casa `phoneE164` (E.164
 * inteiro) OU `name`, e o AuditEvent SOBREVIVE à exclusão LGPD do contato
 * (é trilha de auditoria, não dado do titular — a erasure não o toca). Sem
 * mascarar, um `search=+5592995550101` gravaria o telefone em texto puro
 * numa tabela retida indefinidamente, mesmo depois do titular ser apagado.
 *
 * Mantém runs de até 2 dígitos intactos (não identificam ninguém sozinhos —
 * não vale a pena sacrificar a legibilidade da trilha por eles) e corta
 * qualquer run de 3+ dígitos logo depois dos 2 primeiros. `+5592995550101`
 * vira `+55***`.
 */
export function maskSearchForAudit(
  search: string | undefined,
): string | undefined {
  return search?.replace(/\d{3,}/g, (run) => `${run.slice(0, 2)}***`);
}

@Injectable()
export class ContactsExportService {
  private readonly logger = new Logger(ContactsExportService.name);

  constructor(
    private readonly repo: ContactsRepository,
    private readonly audit: AuditService,
  ) {}

  /**
   * Escreve a planilha DIRETO no destino, em streaming (`WorkbookWriter`), sem
   * montar o arquivo inteiro na memória do worker. Devolve quantas linhas
   * foram contadas — é o número que a auditoria registra.
   *
   * A ordem importa: contar → checar o teto → AUDITAR → só então escrever
   * qualquer cabeçalho. Um export recusado não pode deixar o navegador
   * baixando um arquivo vazio, e um export permitido não pode escapar sem
   * trilha.
   */
  async streamXlsx(
    query: ExportContactsQuery,
    sink: XlsxSink,
  ): Promise<number> {
    const where = buildContactListWhere({ page: 1, pageSize: 1, ...query });
    const total = await this.repo.countWhere(where);
    if (total > CONTACT_EXPORT_ROW_CAP) {
      throw new ValidationError(
        `A seleção tem ${total.toLocaleString('pt-BR')} contatos e o limite da planilha é ${CONTACT_EXPORT_ROW_CAP.toLocaleString('pt-BR')}. Aplique um filtro (cidade, grupo, validação) e exporte por partes.`,
        `export cap exceeded: ${total} > ${CONTACT_EXPORT_ROW_CAP}`,
        'contact.export_too_large',
      );
    }

    // O filtro vai para a trilha de auditoria INTEIRO — cada chave importa
    // para reconstruir "o que foi exportado". Só o VALOR de `search` é
    // mascarado (pode ser um telefone); `city`/`group`/`validity`/etc. não
    // identificam ninguém sozinhos e sobrevivem como vieram.
    await this.audit.log('contact.export_xlsx', 'Contact', undefined, {
      filter: { ...query, search: maskSearchForAudit(query.search) },
      count: total,
    });

    const stamp = new Date().toISOString().slice(0, 10);
    sink.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    sink.setHeader(
      'Content-Disposition',
      `attachment; filename="contatos-${stamp}.xlsx"`,
    );
    sink.setHeader('X-Content-Type-Options', 'nosniff');
    // Corpo é telefone/nome/cidade de eleitor — nunca cacheável, nem por um
    // proxy intermediário nem pelo disco do navegador do operador.
    sink.setHeader('Cache-Control', 'no-store');

    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
      stream: sink,
      useStyles: false,
      useSharedStrings: false,
    });
    const sheet = workbook.addWorksheet('Contatos');

    try {
      sheet.addRow([...CONTACT_EXPORT_HEADERS]).commit();

      let cursor: string | undefined;
      for (;;) {
        const rows = await this.repo.pageForExport(
          where,
          CONTACT_EXPORT_PAGE_SIZE,
          cursor,
        );
        if (rows.length === 0) break;
        for (const c of rows) sheet.addRow(toExportRow(c)).commit();
        cursor = rows[rows.length - 1].id;
        if (rows.length < CONTACT_EXPORT_PAGE_SIZE) break;
      }

      sheet.commit();
      await workbook.commit();
    } catch (err) {
      // Mesmo idioma de chat-media.controller.ts: se os headers HTTP JÁ
      // saíram, não existe mais como responder com um status de erro — o
      // melhor que dá para fazer é derrubar a conexão, para o cliente ver
      // uma falha de rede em vez de um .xlsx TRUNCADO com status 200 (ele
      // abriria no Excel como corrompido, sem nenhum aviso de que faltam
      // linhas). Se ainda não saíram, relança para o filtro global
      // responder normalmente — o caminho de sempre.
      if (sink.headersSent) {
        // Review fix (round 2) — "não dá para responder" não pode virar
        // "some sem deixar rastro": sem isto, um erro genuíno no meio do
        // streaming (ex.: o banco caiu na página 30) desaparecia sem
        // NENHUMA linha de log. Mensagem fixa e a rota fixa no controller —
        // nunca a query, nunca o telefone; a `stack` de um erro de
        // infraestrutura (Prisma/rede) não é escrita por humano, então não
        // carrega dado do titular do mesmo jeito que um DomainError carrega.
        this.logger.error(
          'stream de export abortado após headers (rota /contacts/export.xlsx)',
          err instanceof Error ? err.stack : undefined,
        );
        sink.destroy();
        return total;
      }
      // Os headers de DOWNLOAD já foram SETADOS (não ENVIADOS —
      // `headersSent` ainda é `false` aqui, senão teríamos caído no `if`
      // acima) antes do primeiro byte real ser escrito. Sem remover, o
      // filtro global responde com um corpo JSON de erro, mas o
      // Content-Disposition continua dizendo "attachment; filename=...xlsx"
      // — o navegador salvaria o TEXTO DO ERRO como se fosse a planilha.
      sink.removeHeader('Content-Disposition');
      throw err;
    }

    return total;
  }
}
