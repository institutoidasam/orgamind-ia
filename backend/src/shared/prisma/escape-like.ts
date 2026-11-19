/**
 * O Prisma não escapa os coringas do LIKE no `contains`: "_", "%" e "\" da
 * busca valem como texto depois de passar por aqui. O Postgres usa "\" como
 * escape padrão.
 */
export const escapeLike = (text: string): string =>
  text.replace(/[\\%_]/g, '\\$&');
