import {
  DomainError,
  ValidationError,
} from '../../../shared/errors/domain.error';

export class EmptyWorkbookError extends ValidationError {
  constructor() {
    super(
      'Empty workbook',
      'No worksheets found in uploaded file',
      'excel.empty_workbook',
    );
  }
}

/**
 * Raised when the spreadsheet has more data rows than we allow to be imported
 * synchronously (A8 — guards against decompression bombs and a 10MB xlsx that
 * inflates to hundreds of thousands of rows). 422 Unprocessable Entity.
 */
export class TooManyRowsError extends DomainError {
  constructor(rowCount: number, max: number) {
    super({
      code: 'excel.too_many_rows',
      message: `Planilha excede o limite de ${max.toLocaleString('pt-BR')} linhas`,
      status: 422,
      detail: `A planilha tem ${rowCount.toLocaleString('pt-BR')} linhas; importe em lotes menores.`,
    });
  }
}

/**
 * Raised when two header cells normalize to the same key (e.g. "Nome" and
 * "nome "), which would silently merge/overwrite columns. 422.
 */
export class DuplicateHeaderError extends DomainError {
  constructor(header: string) {
    super({
      code: 'excel.duplicate_header',
      message: 'Cabeçalhos duplicados na planilha',
      status: 422,
      detail: `A coluna "${header}" aparece mais de uma vez (ignorando maiúsculas/espaços).`,
    });
  }
}

/**
 * Raised when exceljs cannot parse the uploaded .xlsx even after the
 * namespace/absolute-target normalization retry (U1). Replaces the raw parser
 * TypeError that used to leak to the user. 422.
 */
export class UnreadableWorkbookError extends DomainError {
  constructor(cause: unknown) {
    super({
      code: 'excel.unreadable_workbook',
      message:
        'Não foi possível ler o arquivo .xlsx. Abra-o no Excel ou Google Sheets, salve novamente como .xlsx e tente importar de novo.',
      status: 422,
      detail: (cause as Error)?.message,
      cause,
    });
  }
}
