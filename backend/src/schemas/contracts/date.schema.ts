import { z } from 'zod';

/**
 * Campo de data/hora dos contratos — ISO na ENTRADA, `Date` na SAÍDA.
 *
 * POR QUE existe (não é preferência de estilo, é o boot da API):
 * o `main.ts` monta o OpenAPI/Swagger sempre que `NODE_ENV !== 'production'`, e
 * o `toJSONSchema` do zod v4 LANÇA `"Date cannot be represented in JSON Schema"`
 * quando o tipo de ENTRADA de algum campo é `Date` — que é exatamente o caso do
 * `z.coerce.date()`. A exceção derruba o PROCESSO no boot, então o que era um
 * detalhe de contrato quebrava o `dev` local e o job e2e (`NODE_ENV=test`); só
 * produção escapava, por ter o Swagger desligado. O `nestjs-zod` não expõe a
 * opção `unrepresentable` do zod, então não há escape pela dependência: a
 * correção tem que ser o campo não ter `Date` na entrada.
 *
 * ACEITA (medido contra o `z.coerce.date()` que substituiu — zero regressão):
 * ISO com `Z`, ISO com offset (`-03:00`), ISO local sem zona, ISO com
 * milissegundos e data-só (`2026-07-27`). Como no `new Date()`, um datetime sem
 * zona é lido como hora LOCAL e a data-só como meia-noite UTC.
 *
 * A SAÍDA continua sendo `Date` — o código e o Prisma dependem disso (ver o
 * `collectedAt.getTime()` do consent-admin).
 *
 * ÚNICA diferença de comportamento: o `z.coerce.date()` aceitava `null` e o
 * coagia para a epoch de 1970 (bug latente — uma data ausente virava "01/01/1970"
 * silenciosamente). Aqui `null` é REJEITADO; quem legitimamente pode ser nulo
 * declara `.nullable()`, que é o que a coluna do Prisma diz.
 *
 * Um objeto `Date` de verdade também é rejeitado (a entrada é string). Isso é
 * coerente com o que estes contratos descrevem: o JSON que trafega na REDE, onde
 * data é sempre string. Se um dia um destes schemas for usado para validar uma
 * row do Prisma direto (Date de verdade, sem serializar), serialize antes.
 *
 * @param params repassado ao `z.union` — serve para a mensagem de erro em PT-BR
 *   (`{ error: '...' }`) dos campos que o operador preenche à mão.
 */
export function dateFromIso(params?: { error?: string }) {
  return z
    .union(
      [z.iso.datetime({ offset: true, local: true }), z.iso.date()],
      params,
    )
    .transform((v) => new Date(v));
}
