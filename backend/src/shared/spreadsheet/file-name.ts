/**
 * Reduz um nome a minúsculas sem acento, números e hífen, para nome de arquivo.
 * NFKD (e não NFD) para `º`/`ª` virarem `o`/`a`. Sem nada aproveitável: `setor`.
 */
export function fileSlug(text: string): string {
  const slug = text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .join('-');
  return slug === '' ? 'setor' : slug;
}
