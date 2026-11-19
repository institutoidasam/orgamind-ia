import type { Writable } from 'node:stream';
import { guardFormula } from './cell-rules';

export const CSV_BOM = '﻿';
export const CSV_SEPARATOR = ';';
export const CSV_EOL = '\r\n';

const NEEDS_QUOTES = /[;"\r\n]/;
const SINK_CLOSED = 'destino fechado antes do fim da exportação';

/** Protege fórmula e depois, se preciso, põe entre aspas (aspas dobradas). */
export function csvField(value: string): string {
  const guarded = guardFormula(value);
  return NEEDS_QUOTES.test(guarded)
    ? `"${guarded.replaceAll('"', '""')}"`
    : guarded;
}

export function csvRow(cells: readonly string[]): string {
  return `${cells.map(csvField).join(CSV_SEPARATOR)}${CSV_EOL}`;
}

/** CSV em streaming: BOM antes da primeira linha e espera `drain` com o destino cheio. */
export class CsvStreamWriter {
  private started = false;

  constructor(private readonly sink: Writable) {}

  async writeRow(cells: readonly string[]): Promise<void> {
    await this.push(`${this.takeBom()}${csvRow(cells)}`);
  }

  async close(): Promise<void> {
    const bom = this.takeBom();
    if (bom) await this.push(bom);
    this.sink.end();
  }

  private takeBom(): string {
    if (this.started) return '';
    this.started = true;
    return CSV_BOM;
  }

  /** Destino já destruído ou encerrado não emite mais `drain`, `error` nem `close`: falhar já. */
  private assertOpen(): void {
    if (this.sink.destroyed || this.sink.writableEnded) {
      throw new Error(SINK_CLOSED);
    }
  }

  private async push(text: string): Promise<void> {
    this.assertOpen();
    if (this.sink.write(text)) return;
    await this.waitDrain();
  }

  private waitDrain(): Promise<void> {
    const { sink } = this;
    return new Promise((resolve, reject) => {
      this.assertOpen();
      const finish = (error?: Error): void => {
        sink.off('drain', onDrain);
        sink.off('error', finish);
        sink.off('close', onClose);
        if (error) reject(error);
        else resolve();
      };
      const onDrain = (): void => finish();
      const onClose = (): void => finish(new Error(SINK_CLOSED));
      sink.on('drain', onDrain);
      sink.on('error', finish);
      sink.on('close', onClose);
    });
  }
}
