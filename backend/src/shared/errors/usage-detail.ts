/**
 * `detail` do 409 de "em uso" (DJ10): só as chaves com valor maior que zero,
 * na ordem do objeto, como `chave=valor` separados por ", ". Recebe contagens,
 * nunca id, nome, telefone ou e-mail.
 */
export function usageDetail(counts: Readonly<Record<string, number>>): string {
  return Object.entries(counts)
    .filter(([, value]) => value > 0)
    .map(([key, value]) => `${key}=${value}`)
    .join(', ');
}
