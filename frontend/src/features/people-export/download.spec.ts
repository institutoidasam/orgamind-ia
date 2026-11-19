import { afterEach, describe, expect, it, vi } from 'vitest';
import { filenameFromDisposition, saveBlob } from './download';

describe('filenameFromDisposition', () => {
  it('lê filename entre aspas e cai na reserva sem header', () => {
    expect(filenameFromDisposition('attachment; filename="pessoas-2026-11-19.xlsx"', 'pessoas.xlsx')).toBe(
      'pessoas-2026-11-19.xlsx',
    );
    expect(
      filenameFromDisposition('attachment; filename=escala-producao-2026-11-16-a-2026-11-22.csv', 'escala.csv'),
    ).toBe('escala-producao-2026-11-16-a-2026-11-22.csv');
    expect(filenameFromDisposition("attachment; filename*=UTF-8''pessoas%20hoje.csv", 'pessoas.csv')).toBe(
      'pessoas hoje.csv',
    );
    expect(filenameFromDisposition(null, 'pessoas.csv')).toBe('pessoas.csv');
    expect(filenameFromDisposition('attachment', 'pessoas.csv')).toBe('pessoas.csv');
  });
});

describe('saveBlob', () => {
  afterEach(() => vi.restoreAllMocks());

  it('cria o link com o nome, clica e revoga a URL', () => {
    const createObjectURL = vi.fn(() => 'blob:fake-url');
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    const clicked: Array<{ href: string; download: string }> = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push({ href: this.href, download: this.download });
      expect(revokeObjectURL).not.toHaveBeenCalled();
    });
    const blob = new Blob(['a;b'], { type: 'text/csv' });

    saveBlob(blob, 'pessoas-2026-11-19.csv');

    expect(createObjectURL).toHaveBeenCalledWith(blob);
    expect(clicked).toEqual([{ href: 'blob:fake-url', download: 'pessoas-2026-11-19.csv' }]);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:fake-url');
  });
});
