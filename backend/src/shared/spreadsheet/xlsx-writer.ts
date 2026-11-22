import type { Writable } from 'node:stream';
import * as ExcelJS from 'exceljs';

const SINK_CLOSED = 'destino fechado antes do fim da exportação';

/**
 * XLSX em streaming: toda célula vai como TEXTO (string do JS: sem fórmula,
 * sem número, sem data nativa) e sem apóstrofo de proteção. O apóstrofo é só
 * do CSV (DX15). `useSharedStrings: false` e `useStyles: false` mantêm a
 * memória baixa, igual ao export de contatos.
 */
export class XlsxStreamWriter {
  private readonly workbook: ExcelJS.stream.xlsx.WorkbookWriter;
  private sheet: ExcelJS.Worksheet | undefined;

  constructor(private readonly sink: Writable) {
    this.workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
      stream: sink,
      useStyles: false,
      useSharedStrings: false,
    });
  }

  /** Abre uma aba nova depois de fechar (commit) a anterior, se houver. */
  startSheet(name: string): void {
    this.sheet?.commit();
    this.sheet = this.workbook.addWorksheet(name);
  }

  /** Falha vira rejeição da Promise (o executor que lança rejeita), igual ao CSV. */
  writeRow(cells: readonly string[]): Promise<void> {
    return new Promise((resolve) => {
      this.assertOpen();
      if (!this.sheet) throw new Error('startSheet antes de writeRow');
      this.sheet.addRow([...cells]).commit();
      resolve();
    });
  }

  /**
   * Fecha a aba e o arquivo. Destino já destruído ou encerrado: nada a entregar, resolve
   * (igual ao CSV). Destino que fecha ou falha no meio do fechamento: rejeita,
   * porque o `commit()` do exceljs só espera `finish`/`error` e ficaria pendurado.
   */
  async close(): Promise<void> {
    this.sheet?.commit();
    this.sheet = undefined;
    if (this.sink.destroyed || this.sink.writableEnded) return;
    await this.finalize();
  }

  /** Destino já destruído ou encerrado não emite mais `finish`, `error` nem `close`: falhar já. */
  private assertOpen(): void {
    if (this.sink.destroyed || this.sink.writableEnded) {
      throw new Error(SINK_CLOSED);
    }
  }

  private finalize(): Promise<void> {
    const { sink } = this;
    return new Promise((resolve, reject) => {
      const settle = (error?: Error): void => {
        sink.off('finish', onFinish);
        sink.off('error', settle);
        sink.off('close', onClose);
        if (error) reject(error);
        else resolve();
      };
      const onFinish = (): void => settle();
      // `close` pode vir logo depois de `finish` (autoDestroy): só é falha sem `finish`.
      const onClose = (): void =>
        settle(sink.writableFinished ? undefined : new Error(SINK_CLOSED));
      sink.on('finish', onFinish);
      sink.on('error', settle);
      sink.on('close', onClose);
      this.workbook.commit().catch(settle);
    });
  }
}
