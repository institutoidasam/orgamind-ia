import type { Writable } from 'node:stream';
import type { Logger } from '@nestjs/common';
import type { SpreadsheetFormat } from './spreadsheet-writer';

/** O `res` do Express em produção; um `PassThrough` com os três campos no teste. */
export type DownloadSink = Writable & {
  setHeader(name: string, value: string): void;
  removeHeader(name: string): void;
  headersSent: boolean;
};

export const SPREADSHEET_CONTENT_TYPE: Readonly<
  Record<SpreadsheetFormat, string>
> = {
  csv: 'text/csv; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

/** Fora de ASCII imprimível, aspas e barra invertida viram `_`: o nome cabe entre aspas no header. */
const UNSAFE_FILE_NAME_CHAR = /[^\x20-\x7e]|["\\]/g;

/**
 * Cinco headers do download. O `Access-Control-Expose-Headers` só faz
 * diferença no desenvolvimento (API em outra origem): sem ele o navegador não
 * deixa o front ler o nome do arquivo (DX11).
 */
export function setDownloadHeaders(
  sink: DownloadSink,
  input: { format: SpreadsheetFormat; fileName: string },
): void {
  const fileName = input.fileName.replace(UNSAFE_FILE_NAME_CHAR, '_');
  sink.setHeader('Content-Type', SPREADSHEET_CONTENT_TYPE[input.format]);
  sink.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  sink.setHeader('X-Content-Type-Options', 'nosniff');
  sink.setHeader('Cache-Control', 'no-store');
  sink.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
}

/**
 * Falha no meio da exportação. Com os headers já enviados não existe mais
 * status de erro para devolver: registra (mensagem fixa, nunca query nem
 * telefone) e derruba a conexão, para o cliente ver falha de rede em vez de
 * um arquivo truncado com 200. Antes disso, desfaz os headers de download
 * para o corpo de erro não sair disfarçado de planilha, e relança (DX10).
 */
export function failDownload(input: {
  sink: DownloadSink;
  error: unknown;
  logger: Logger;
  route: string;
}): void {
  const { sink, error, logger, route } = input;
  if (sink.headersSent) {
    logger.error(
      `stream de exportação abortado após headers (rota ${route})`,
      error instanceof Error ? error.stack : undefined,
    );
    sink.destroy();
    return;
  }
  sink.removeHeader('Content-Disposition');
  sink.removeHeader('Content-Type');
  throw error;
}
