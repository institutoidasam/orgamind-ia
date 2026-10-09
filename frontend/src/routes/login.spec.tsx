import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('/login — marca', () => {
  it('preserva a cor laranja nativa do SVG contra o painel navy', () => {
    const source = readFileSync(resolve(__dirname, 'login.tsx'), 'utf8');

    expect(source).toContain('className="size-7"');
    expect(source).not.toMatch(/brightness-0\s+invert/);
  });
});
