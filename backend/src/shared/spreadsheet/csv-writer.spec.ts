import { describe, it, expect } from 'vitest';
import { PassThrough, Writable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { CSV_BOM, CsvStreamWriter, csvField, csvRow } from './csv-writer';

function collect(sink: PassThrough): Promise<Buffer> {
  const chunks: Buffer[] = [];
  sink.on('data', (chunk: Buffer) => chunks.push(chunk));
  return new Promise((resolve) =>
    sink.on('end', () => resolve(Buffer.concat(chunks))),
  );
}

/** Falha (em vez de esperar sem fim) se a Promise não assentar em `ms`. */
function settlesWithin<T>(promise: Promise<T>, ms = 300): Promise<T> {
  const hung = sleep(ms, undefined, { ref: false }).then((): never => {
    throw new Error(`pendurado: sem resolver nem rejeitar em ${ms} ms`);
  });
  return Promise.race([promise, hung]);
}

describe('csvField', () => {
  it('gatilho de fórmula ganha apóstrofo antes das aspas; ; aspas e quebras vão entre aspas', () => {
    expect(csvField('Maria')).toBe('Maria');
    expect(csvField('')).toBe('');
    expect(csvField('=1+1')).toBe("'=1+1");
    expect(csvField('=A;B')).toBe('"\'=A;B"');
    expect(csvField('+1 415 555 2671')).toBe("'+1 415 555 2671");
    expect(csvField("'=x")).toBe("''=x");
    expect(csvField('a;b')).toBe('"a;b"');
    expect(csvField('diz "oi"')).toBe('"diz ""oi"""');
    expect(csvField('linha1\nlinha2')).toBe('"linha1\nlinha2"');
    expect(csvField('\rx')).toBe('"\'\rx"');
  });
});

describe('csvRow', () => {
  it('separador ; e fim CRLF', () => {
    expect(csvRow(['a', 'b;c', ''])).toBe('a;"b;c";\r\n');
  });
});

describe('CsvStreamWriter', () => {
  it('BOM só no começo, linhas na ordem, end no close', async () => {
    const sink = new PassThrough();
    const bytes = collect(sink);
    const writer = new CsvStreamWriter(sink);
    await writer.writeRow(['matricula', 'nome']);
    await writer.writeRow(['1', 'Ana']);
    await writer.close();
    const out = await bytes;
    expect([...out.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(out.toString('utf8')).toBe(`${CSV_BOM}matricula;nome\r\n1;Ana\r\n`);
  });

  it('close sem linhas ainda grava o BOM', async () => {
    const sink = new PassThrough();
    const bytes = collect(sink);
    await new CsvStreamWriter(sink).close();
    expect([...(await bytes)]).toEqual([0xef, 0xbb, 0xbf]);
  });
});

describe('CsvStreamWriter espera drain', () => {
  it('só resolve depois que o destino libera o write (drain)', async () => {
    let release: () => void = () => undefined;
    const sink = new Writable({
      highWaterMark: 1,
      write(_chunk, _enc, callback) {
        release = () => callback();
      },
    });
    let resolved = false;
    const pending = new CsvStreamWriter(sink).writeRow(['a', 'b']).then(() => {
      resolved = true;
    });
    await new Promise((done) => setImmediate(done));
    expect(resolved).toBe(false);
    release();
    await pending;
    expect(resolved).toBe(true);
  });
});

describe('CsvStreamWriter destino fechado', () => {
  const stalled = (): Writable =>
    new Writable({ highWaterMark: 1, write() {} });

  it('rejeita a espera de drain quando o destino fecha antes', async () => {
    const sink = stalled();
    const pending = new CsvStreamWriter(sink).writeRow(['a']);
    sink.destroy();
    await expect(pending).rejects.toThrow('destino fechado');
  });

  it('rejeita com o erro do destino emitido durante a espera', async () => {
    const sink = stalled();
    const pending = new CsvStreamWriter(sink).writeRow(['a']);
    sink.destroy(new Error('disco cheio'));
    await expect(pending).rejects.toThrow('disco cheio');
  });

  it.each([
    ['destruído e já fechado', (s: Writable) => s.destroy(), true],
    ['encerrado com end() e já fechado', (s: Writable) => s.end(), true],
    ['encerrado com end() ainda aberto', (s: Writable) => s.end(), false],
  ])('writeRow em destino %s rejeita sem pendurar', async (_n, act, settle) => {
    const sink = stalled();
    act(sink);
    if (settle) await new Promise((done) => setImmediate(done));
    const writer = new CsvStreamWriter(sink);
    await expect(settlesWithin(writer.writeRow(['a']))).rejects.toThrow(
      'destino fechado',
    );
  });

  it('close sem linhas em destino já fechado rejeita sem pendurar', async () => {
    const sink = stalled();
    sink.destroy();
    await new Promise((done) => setImmediate(done));
    const writer = new CsvStreamWriter(sink);
    await expect(settlesWithin(writer.close())).rejects.toThrow(
      'destino fechado',
    );
  });
});
