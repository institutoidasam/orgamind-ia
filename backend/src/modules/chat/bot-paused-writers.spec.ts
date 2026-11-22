import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/** `backend/src` (este arquivo mora em `backend/src/modules/chat`). */
const SRC = join(__dirname, '..', '..');

type Source = { file: string; text: string };

/** Fontes de produção: todo `.ts` de `backend/src` menos `*.spec.ts` e `*.test-fixtures.ts`. */
function productionSources(dir = SRC): Source[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name);
    if (e.isDirectory()) return productionSources(full);
    if (!e.name.endsWith('.ts') || /\.(spec|test-fixtures)\.ts$/.test(e.name))
      return [];
    return [
      {
        file: relative(SRC, full).split(sep).join('/'),
        text: readFileSync(full, 'utf8'),
      },
    ];
  });
}

/** Método de classe (indentação de 2) em que o índice cai: o último cabeçalho antes dele. */
function enclosingMethod(text: string, index: number): string | undefined {
  const heads = [
    ...text
      .slice(0, index)
      .matchAll(
        /^ {2}(?:(?:public|private|protected)\s+)?(?:async\s+)?(\w+)\s*\(/gm,
      ),
  ];
  return heads.at(-1)?.[1];
}

/** A linha inteira em que o índice cai. */
function lineAt(text: string, index: number): string {
  const start = text.lastIndexOf('\n', index) + 1;
  const end = text.indexOf('\n', index);
  return text.slice(start, end === -1 ? undefined : end);
}

// `botPausedAt: null`, `botPausedAt = null`, `botPausedAt: { set: null }` e SQL `"botPausedAt" = NULL`.
const CLEARS_PAUSE =
  /botPausedAt"?\s*[:=]\s*(?:\{\s*set\s*:\s*)?null\b|"botPausedAt"\s*=\s*NULL/i;

describe('K3-7(b) só "Retomar robô" retoma o robô (varredura estática de backend/src)', () => {
  it('K3-7(b): só chat.repository.ts grava botPausedAt null', () => {
    const sources = productionSources();
    // Trava contra o caminho novo que "ajuda" e zera a pausa (resolver, reabrir, transferir, passar turno).
    expect(sources.length).toBeGreaterThan(100); // a varredura achou o código, não uma pasta vazia
    const writers = sources
      .filter((s) => CLEARS_PAUSE.test(s.text))
      .map((s) => s.file);
    expect(writers).toEqual(['modules/chat/chat.repository.ts']);
  });

  it('K3-7(b): clearBotPaused só é chamado por resumeBot', () => {
    const uses = productionSources().flatMap(({ file, text }) =>
      [...text.matchAll(/\bclearBotPaused\b/g)]
        .filter(
          (m) =>
            !/^\s*(?:async\s+)?clearBotPaused\s*\(/.test(lineAt(text, m.index)),
        ) // a declaração não é chamada
        .map((m) => `${file}#${enclosingMethod(text, m.index)}`),
    );
    expect(uses).toEqual(['modules/chat/chat.service.ts#resumeBot']);
  });

  it('K3-7(b): o detector pega as formas de zerar a pausa e ignora leitura e tipo', () => {
    // Calibra a varredura: sem isto, uma regex frouxa passaria "verde" sem olhar nada.
    for (const zera of [
      'data: { botPausedAt: null }',
      'data.botPausedAt = null;',
      'botPausedAt: { set: null }',
      'SET "botPausedAt" = NULL',
    ]) {
      expect(CLEARS_PAUSE.test(zera), zera).toBe(true);
    }
    for (const nao of [
      'row.botPausedAt !== null',
      'botPausedAt: Date | null;',
      'data.botPausedAt = now;',
      'botPausedAt: new Date()',
    ]) {
      expect(CLEARS_PAUSE.test(nao), nao).toBe(false);
    }
  });
});
