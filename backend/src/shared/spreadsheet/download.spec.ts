import { describe, it, expect, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { Logger } from '@nestjs/common';
import {
  failDownload,
  setDownloadHeaders,
  type DownloadSink,
} from './download';

/** Um destino que se comporta como o `res` do Express: guarda os headers e sabe se já saíram. */
function makeSink(headersSent = false) {
  const headers = new Map<string, string>();
  const sink = Object.assign(new PassThrough(), {
    setHeader: (name: string, value: string) => void headers.set(name, value),
    removeHeader: (name: string) => void headers.delete(name),
    headersSent,
  });
  return { sink: sink as DownloadSink, headers };
}

describe('setDownloadHeaders', () => {
  it.each([
    ['csv', 'text/csv; charset=utf-8'],
    [
      'xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ],
  ] as const)(
    'setDownloadHeaders grava os cinco headers por formato (%s)',
    (format, contentType) => {
      const { sink, headers } = makeSink();
      setDownloadHeaders(sink, { format, fileName: `pessoas.${format}` });
      expect(Object.fromEntries(headers)).toEqual({
        'Content-Type': contentType,
        'Content-Disposition': `attachment; filename="pessoas.${format}"`,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
        'Access-Control-Expose-Headers': 'Content-Disposition',
      });
    },
  );

  it('nome com aspas, barra, acento ou quebra de linha vira ASCII seguro', () => {
    const { sink, headers } = makeSink();
    setDownloadHeaders(sink, {
      format: 'csv',
      fileName: 'escala-"açaí"\\\r\nx.csv',
    });
    expect(headers.get('Content-Disposition')).toBe(
      'attachment; filename="escala-_a_a_____x.csv"',
    );
  });
});

describe('failDownload', () => {
  const route = '/internal/people-export/people';

  it('failDownload antes dos headers saírem: tira Content-Disposition e relança', () => {
    const { sink, headers } = makeSink(false);
    setDownloadHeaders(sink, { format: 'xlsx', fileName: 'pessoas.xlsx' });
    const logger = new Logger('teste');
    const logged = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const error = new Error('Há pessoas demais');

    expect(() => failDownload({ sink, error, logger, route })).toThrow(error);
    expect(headers.has('Content-Disposition')).toBe(false);
    expect(headers.has('Content-Type')).toBe(false);
    expect(sink.destroyed).toBe(false);
    expect(logged).not.toHaveBeenCalled();
  });

  it('failDownload depois dos headers: registra mensagem fixa e destrói o destino, sem relançar', () => {
    const { sink } = makeSink(true);
    const logger = new Logger('teste');
    const logged = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const error = new Error('telefone +5592991110001 sem permissão');

    failDownload({ sink, error, logger, route });

    expect(logged).toHaveBeenCalledOnce();
    expect(logged).toHaveBeenCalledWith(
      `stream de exportação abortado após headers (rota ${route})`,
      error.stack,
    );
    expect(logged.mock.calls[0][0]).not.toContain('telefone');
    expect(sink.destroyed).toBe(true);
  });

  it('cliente que já desconectou: registra, não relança e o destroy repetido é inofensivo', () => {
    const { sink } = makeSink(true);
    sink.destroy();
    const logger = new Logger('teste');
    const logged = vi.spyOn(logger, 'error').mockImplementation(() => {});

    failDownload({ sink, error: 'falha sem stack', logger, route });

    expect(logged).toHaveBeenCalledWith(expect.any(String), undefined);
  });
});
