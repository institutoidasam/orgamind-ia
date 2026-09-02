import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { mockDeep, type MockProxy } from 'vitest-mock-extended';
import { FailureReason } from '@prisma/client';
import { Logger } from '@nestjs/common';
import { ContactsRepository } from './contacts.repository';
import { AuditService } from '../../shared/audit/audit.service';
import {
  CONTACT_EXPORT_HEADERS,
  CONTACT_EXPORT_PAGE_SIZE,
  CONTACT_EXPORT_ROW_CAP,
  ContactsExportService,
  maskSearchForAudit,
  toExportRow,
  type XlsxSink,
} from './contacts-export.service';
import { invalidContactWhere } from '../../shared/contact-validity';
import { ValidationError } from '../../shared/errors/domain.error';

/** Um destino de escrita que se comporta como o `res` do Express. */
function makeSink() {
  const pt = new PassThrough();
  // Drenar é obrigatório: sem leitor, o WorkbookWriter trava no backpressure.
  pt.resume();
  const headers: Record<string, string> = {};
  const sink = Object.assign(pt, {
    setHeader: (k: string, v: string) => {
      headers[k] = v;
    },
    removeHeader: (k: string) => {
      delete headers[k];
    },
  });
  return { sink: sink as unknown as XlsxSink, headers };
}

const ROW = {
  id: 'c1',
  phoneE164: '+5592995550101',
  name: 'Ana',
  city: 'Manaus',
  group: 'Zona Leste',
  tags: ['apoiador', 'zona-leste'],
  whatsappValid: null,
  whatsappCheckedAt: null,
  lastFailureReason: FailureReason.SEM_WHATSAPP,
  lastFailureAt: new Date('2026-08-20T13:00:00Z'),
  messages: [],
};

describe('toExportRow — as 8 colunas, em PT-BR', () => {
  it('traduz situação e motivo para o vocabulário do operador', () => {
    const row = toExportRow(ROW);
    expect(row[0]).toBe('+5592995550101');
    expect(row[1]).toBe('Ana');
    expect(row[2]).toBe('Manaus');
    expect(row[3]).toBe('Zona Leste');
    expect(row[4]).toBe('apoiador, zona-leste');
    expect(row[5]).toBe('Inválido confirmado');
    expect(row[6]).toBe('Número não tem WhatsApp');
    expect(row[7]).toMatch(/^\d{2}\/\d{2}\/\d{4}/);
  });

  it('contato mudo: situação "Não validado", motivo e data vazios', () => {
    const row = toExportRow({
      ...ROW,
      lastFailureReason: null,
      lastFailureAt: null,
    });
    expect(row[5]).toBe('Não validado');
    expect(row[6]).toBe('');
    expect(row[7]).toBe('');
  });

  // A entrega é o que prova o número — o `messages` do select traz no máximo
  // UMA linha DELIVERED/READ, só para responder "houve entrega?".
  it('uma entrega provada vira "Válido" mesmo com whatsappValid NULL', () => {
    const row = toExportRow({
      ...ROW,
      lastFailureReason: null,
      messages: [{ id: 'm1' }],
    });
    expect(row[5]).toBe('Válido');
  });

  it('a "última tentativa" cai para whatsappCheckedAt quando não houve falha', () => {
    const row = toExportRow({
      ...ROW,
      lastFailureReason: null,
      lastFailureAt: null,
      whatsappCheckedAt: new Date('2026-08-21T13:00:00Z'),
    });
    expect(row[7]).toMatch(/^\d{2}\/\d{2}\/\d{4}/);
  });
});

/**
 * Review fix (round 1, finding #4) — o AuditEvent sobrevive à exclusão LGPD
 * do contato. `search` casa `phoneE164` inteiro; sem mascarar, o telefone
 * ficaria retido para sempre numa tabela que a erasure não toca.
 */
describe('maskSearchForAudit — a trilha de auditoria nunca guarda o telefone em texto puro', () => {
  it('mantém os 2 primeiros dígitos de um run de 3+ e mascara o resto', () => {
    expect(maskSearchForAudit('+5592995550101')).toBe('+55***');
  });

  it('texto sem sequência de 3+ dígitos passa intacto', () => {
    expect(maskSearchForAudit('Ana')).toBe('Ana');
  });

  it('undefined permanece undefined (nenhum filtro `search` aplicado)', () => {
    expect(maskSearchForAudit(undefined)).toBeUndefined();
  });
});

describe('ContactsExportService.streamXlsx', () => {
  let repo: MockProxy<ContactsRepository>;
  let audit: MockProxy<AuditService>;
  let service: ContactsExportService;
  // Mudo por padrão: só as 2 specs de erro-no-meio-do-stream olham para
  // isto. As demais nem tocam `this.logger`, mas mockar aqui poupa cada
  // teste de silenciar o console por conta própria.
  let loggerError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    repo = mockDeep<ContactsRepository>();
    audit = mockDeep<AuditService>();
    repo.countWhere.mockResolvedValue(1);
    repo.pageForExport.mockResolvedValue([ROW] as never);
    service = new ContactsExportService(repo, audit);
    loggerError = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
  });

  afterEach(() => loggerError.mockRestore());

  // O mock ignora `where` — o que se asserta é o ARGUMENTO da chamada.
  it('leva o MESMO recorte da lista para a contagem e para as páginas', async () => {
    const { sink } = makeSink();
    await service.streamXlsx(
      { validity: 'invalid', city: 'Manaus' } as never,
      sink,
    );

    const expected = { city: 'Manaus', AND: [invalidContactWhere()] };
    expect(repo.countWhere).toHaveBeenCalledWith(expected);
    expect(repo.pageForExport).toHaveBeenCalledWith(
      expected,
      CONTACT_EXPORT_PAGE_SIZE,
      undefined,
    );
  });

  it('grava AuditEvent com o filtro aplicado e a contagem', async () => {
    repo.countWhere.mockResolvedValue(1234);
    const { sink } = makeSink();
    await service.streamXlsx({ validity: 'invalid' } as never, sink);

    expect(audit.log).toHaveBeenCalledWith(
      'contact.export_xlsx',
      'Contact',
      undefined,
      expect.objectContaining({
        count: 1234,
        filter: expect.objectContaining({ validity: 'invalid' }),
      }),
    );
  });

  /**
   * Review fix (round 1, finding #4) — o `search` gravado na trilha vinha
   * cru: um `?search=+5592995550101` (telefone inteiro) ficava em texto
   * puro numa tabela que a exclusão LGPD do contato não toca. As DEMAIS
   * chaves do filtro seguem intactas — só o VALOR de `search` é mascarado.
   */
  it('audita o `search` MASCARADO — nenhuma sequência de 3+ dígitos sobrevive na trilha', async () => {
    const { sink } = makeSink();
    await service.streamXlsx(
      { search: '+5592995550101', city: 'Manaus' },
      sink,
    );

    expect(audit.log).toHaveBeenCalledWith(
      'contact.export_xlsx',
      'Contact',
      undefined,
      expect.objectContaining({
        filter: expect.objectContaining({
          search: '+55***',
          city: 'Manaus', // as OUTRAS chaves não são tocadas
        }),
      }),
    );
    const [, , , metadata] = audit.log.mock.calls[0];
    expect(JSON.stringify(metadata)).not.toMatch(/\d{4,}/);
  });

  /**
   * O teto não é performance — é VAZAMENTO. Uma planilha com a base inteira de
   * uma campanha eleitoral é o pior arquivo que pode sair deste sistema por
   * acidente. Acima do teto o operador precisa dizer QUAL recorte quer.
   */
  it('acima de 50.000 linhas recusa com 400 e diz quantas são', async () => {
    repo.countWhere.mockResolvedValue(CONTACT_EXPORT_ROW_CAP + 1);
    const { sink } = makeSink();
    await expect(service.streamXlsx({}, sink)).rejects.toThrow(ValidationError);
    await expect(service.streamXlsx({}, sink)).rejects.toThrow(/50\.001|50001/);
    expect(repo.pageForExport).not.toHaveBeenCalled();
  });

  it('recusado pelo teto, NÃO escreve cabeçalho de download nenhum', async () => {
    repo.countWhere.mockResolvedValue(CONTACT_EXPORT_ROW_CAP + 1);
    const { sink, headers } = makeSink();
    await service.streamXlsx({}, sink).catch(() => undefined);
    expect(headers['Content-Disposition']).toBeUndefined();
  });

  it('responde como .xlsx, em anexo, sem MIME-sniffing e sem cache', async () => {
    const { sink, headers } = makeSink();
    await service.streamXlsx({}, sink);
    expect(headers['Content-Type']).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect(headers['Content-Disposition']).toMatch(
      /^attachment; filename="contatos-.*\.xlsx"$/,
    );
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
    // Corpo é telefone/nome/cidade de eleitor — nunca cacheável.
    expect(headers['Cache-Control']).toBe('no-store');
  });

  // Cursor, e não `skip`: numa base de dezenas de milhares o `skip` cresce em
  // custo a cada página, e a 50ª página do export ficaria mais cara que a 1ª.
  it('pagina por CURSOR: a 2ª página parte do último id da 1ª', async () => {
    repo.countWhere.mockResolvedValue(CONTACT_EXPORT_PAGE_SIZE + 1);
    const first = Array.from({ length: CONTACT_EXPORT_PAGE_SIZE }, (_, i) => ({
      ...ROW,
      id: `c${i}`,
    }));
    repo.pageForExport
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce([{ ...ROW, id: 'zz' }] as never)
      .mockResolvedValueOnce([] as never);

    const { sink } = makeSink();
    const total = await service.streamXlsx({}, sink);

    expect(total).toBe(CONTACT_EXPORT_PAGE_SIZE + 1);
    expect(repo.pageForExport).toHaveBeenNthCalledWith(
      2,
      {},
      CONTACT_EXPORT_PAGE_SIZE,
      `c${CONTACT_EXPORT_PAGE_SIZE - 1}`,
    );
  });

  /**
   * Review fix (round 1, finding #2) — sem isto, uma falha NO MEIO da
   * paginação (ex.: o banco caiu na página 2) deixava o WorkbookWriter
   * simplesmente parar: o cliente ficava com um .xlsx TRUNCADO e a resposta
   * HTTP nunca recebia um status de erro — o download "termina" como se
   * tivesse dado certo. `headersSent` fixo em `true` no fake sink (em vez de
   * depender do timing real do ExcelJS/zlib) é o que torna este teste
   * determinístico: o que se testa é o `if`, não a tubulação por baixo.
   */
  it('erro no meio da paginação, com headers HTTP já enviados: derruba a conexão, não relança', async () => {
    repo.countWhere.mockResolvedValue(CONTACT_EXPORT_PAGE_SIZE + 1);
    const first = Array.from({ length: CONTACT_EXPORT_PAGE_SIZE }, (_, i) => ({
      ...ROW,
      id: `c${i}`,
    }));
    repo.pageForExport
      .mockResolvedValueOnce(first)
      .mockRejectedValueOnce(new Error('db blip mid-export'));

    const pt = new PassThrough();
    pt.resume();
    const sink = Object.assign(pt, {
      setHeader: () => undefined,
      headersSent: true,
    }) as unknown as XlsxSink;
    const destroySpy = vi.spyOn(sink, 'destroy');

    const total = await service.streamXlsx({}, sink);

    expect(destroySpy).toHaveBeenCalledTimes(1);
    expect(total).toBe(CONTACT_EXPORT_PAGE_SIZE + 1);

    // Review fix (round 2) — sem isto, o erro desaparecia: nenhuma linha de
    // log, nenhuma pista de que um export morreu no meio. Mensagem fixa (a
    // rota está fixa no controller, nunca precisa da query) e a `stack` do
    // erro de infraestrutura — nunca `query`, nunca telefone.
    expect(loggerError).toHaveBeenCalledTimes(1);
    expect(loggerError.mock.calls[0][0]).toBe(
      'stream de export abortado após headers (rota /contacts/export.xlsx)',
    );
  });

  it('erro ANTES de qualquer header HTTP sair: relança, para o filtro global responder normalmente', async () => {
    repo.countWhere.mockResolvedValue(1);
    repo.pageForExport.mockRejectedValueOnce(new Error('db down'));

    const pt = new PassThrough();
    pt.resume();
    const removeHeader = vi.fn();
    const sink = Object.assign(pt, {
      setHeader: () => undefined,
      removeHeader,
      headersSent: false,
    }) as unknown as XlsxSink;
    const destroySpy = vi.spyOn(sink, 'destroy');

    await expect(service.streamXlsx({}, sink)).rejects.toThrow('db down');
    expect(destroySpy).not.toHaveBeenCalled();

    // Review fix (round 2, minor) — sem isto, o filtro global responderia
    // com um corpo JSON de erro mas o Content-Disposition continuaria
    // dizendo "attachment; filename=...xlsx", e o navegador salvaria o
    // TEXTO DO ERRO como se fosse a planilha.
    expect(removeHeader).toHaveBeenCalledWith('Content-Disposition');
  });

  it('escreve um .xlsx de verdade (assinatura de ZIP "PK") no destino', async () => {
    const pt = new PassThrough();
    const chunks: Buffer[] = [];
    pt.on('data', (c: Buffer) => chunks.push(c));
    const sink = Object.assign(pt, {
      setHeader: () => undefined,
    }) as unknown as XlsxSink;

    await service.streamXlsx({}, sink);
    const head = Buffer.concat(chunks).subarray(0, 2).toString('latin1');
    expect(head).toBe('PK');
  });

  it('o cabeçalho da planilha tem as 8 colunas da spec, nesta ordem', () => {
    expect([...CONTACT_EXPORT_HEADERS]).toEqual([
      'Telefone',
      'Nome',
      'Cidade',
      'Grupo',
      'Tags',
      'Situação',
      'Motivo',
      'Última tentativa',
    ]);
  });
});
