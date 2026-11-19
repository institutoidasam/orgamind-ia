/** Parâmetros `nome=valor` do header, depois do tipo (`attachment`); nome em minúsculas. */
function dispositionParams(header: string): Map<string, string> {
  const params = new Map<string, string>();
  for (const part of header.split(';').slice(1)) {
    const separator = part.indexOf('=');
    if (separator > 0) params.set(part.slice(0, separator).trim().toLowerCase(), part.slice(separator + 1).trim());
  }
  return params;
}

function unquote(value: string): string {
  return value.length >= 2 && value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
}

/** `filename*=UTF-8''nome%20com%20espaco.csv`: o valor vem depois do charset e do idioma. */
function decodeExtended(value: string): string {
  const encoded = value.slice(value.lastIndexOf("'") + 1);
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}

/**
 * Nome do arquivo no `Content-Disposition` da resposta (`filename*=`, `filename="..."`
 * ou `filename=...`). Sem o header, ou sem nome nele, vale a reserva montada no front.
 */
export function filenameFromDisposition(header: string | null, fallback: string): string {
  if (!header) return fallback;
  const params = dispositionParams(header);
  const extended = params.get('filename*');
  const plain = params.get('filename');
  const name = (extended ? decodeExtended(extended) : '') || (plain ? unquote(plain) : '');
  return name.trim() || fallback;
}

/**
 * Entrega o Blob ao navegador como download. A URL só é revogada depois do clique,
 * mesmo que ele lance, para não vazar o Blob URL.
 */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
  } finally {
    URL.revokeObjectURL(url);
  }
}
