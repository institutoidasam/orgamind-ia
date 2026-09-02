/// <reference types="vite/client" />
import { describe, it, expect } from 'vitest';
// Mesmo import que o nestjs-zod faz (node_modules/nestjs-zod/dist/dto-*.cjs,
// função `generateJsonSchema`): `toJSONSchema` vem de 'zod/v4/core', não do
// `z` do pacote 'zod'. Importar daqui garante que estamos exercitando o MESMO
// caminho de código que o Swagger, e não um parecido.
import { toJSONSchema } from 'zod/v4/core';
import { Test } from '@nestjs/testing';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { CONTROLLER_WATERMARK } from '@nestjs/common/constants';

/**
 * GUARDA DE REGRESSÃO: nenhum schema de contrato / DTO pode ser irrepresentável
 * em JSON Schema.
 *
 * POR QUE este teste existe (e por que ele varre em vez de listar):
 * o `main.ts` monta o OpenAPI no boot sempre que `NODE_ENV !== 'production'`.
 * O `toJSONSchema` do zod v4 LANÇA em qualquer campo cujo tipo de ENTRADA seja
 * `Date` — o caso do `z.coerce.date()` — e, até um commit anterior, essa
 * exceção derrubava o PROCESSO. O sintoma só aparecia no BOOT, num job (e2e)
 * que ninguém olhava: o CI ficou vermelho por mais de um mês por causa de um
 * campo de data. O `main.ts` agora sobe mesmo assim (defesa em profundidade),
 * mas subir sem documentação continua sendo um defeito — é este teste que o
 * pega, em segundos, no lugar certo.
 *
 * TRÊS varreduras, três garantias DIFERENTES (leia antes de assumir que uma
 * cobre a outra):
 *
 * 1. `modulosDeContrato` — todo `*.schema.ts` dentro de `contracts/` (recursivo,
 *    incluindo subpastas) é exercitado direto com `toJSONSchema`. Rápida e com
 *    o nome do export no relatório, mas só vê o que está debaixo de `contracts/`.
 * 2. `modulosDeDto` — todo `*.dto.ts` EXPORTADO é exercitado via
 *    `_OPENAPI_METADATA_FACTORY` (o mesmo método que o @nestjs/swagger chama).
 *    Rápida e com nome do export no relatório, mas `import.meta.glob` só
 *    enxerga BINDINGS EXPORTADOS que batem o sufixo do arquivo — um DTO
 *    declarado inline num `*.controller.ts` (arquivo errado) e não-exportado
 *    (binding inexistente) escapa das duas condições ao mesmo tempo, e
 *    NENHUM glob "mais esperto" resolve isso: não há como importar uma
 *    classe que o próprio módulo nunca exportou. Foi exatamente esse buraco
 *    que este teste tinha antes de a varredura 3 existir (ver
 *    `chat-sync.controller.ts` → `SyncDto`, que não é exportado).
 * 3. `controllers` (describe mais abaixo) — fecha o buraco da 2: em vez de
 *    importar o DTO pelo nome, constrói um app Nest de verdade com TODO
 *    controller real da árvore e chama `SwaggerModule.createDocument`, o
 *    MESMO caminho que `main.ts` usa no boot. Um DTO inline não precisa ser
 *    exportado para isso funcionar — a classe do controller já carrega a
 *    referência via `@Body() body: SyncDto` (metadata `design:paramtypes`
 *    emitida pelo compilador no PRÓPRIO arquivo), e é o controller (sempre
 *    exportado — Nest exige isso para poder registrá-lo num `@Module`) que a
 *    varredura importa. Cobre por construção qualquer DTO alcançável por uma
 *    rota real, inline ou não, exportado ou não.
 *
 * O QUE CONTINUA FORA mesmo com as três: (a) um schema de contrato exportado
 * de `contracts/` mas nunca usado por nenhum DTO nem por nenhuma rota (a
 * varredura 1 ainda cobre esse caso, então na prática só fica de fora um
 * schema solto fora de `contracts/` E nunca referenciado por um controller);
 * (b) um DTO usado por um controller que não vive num arquivo `*.controller.ts`
 * nem está registrado em nenhum módulo real (não geraria rota de verdade, logo
 * não é exercitado por `main.ts` em produção — risco teórico, não observado
 * na árvore); (c) qualquer schema nunca alcançado por NENHUM dos três
 * caminhos acima (ex.: um DTO calculado dinamicamente em runtime fora de
 * qualquer arquivo estático) — inerente a qualquer análise estática/glob.
 *
 * A varredura é programática de propósito: um teste que listasse os schemas à
 * mão só cobriria os de hoje. Assim, todo schema de contrato, todo DTO e todo
 * controller que alguém adicionar amanhã já nasce coberto, sem ninguém
 * lembrar de vir aqui.
 */

// `import.meta.glob` é resolvido pelo Vite em tempo de build do teste, então a
// lista é estática (não há leitura de diretório em runtime) e um arquivo novo
// entra na varredura sozinho.
// (O `tsc -p tsconfig.json` avisa TS1470 aqui — `import.meta` sob
// `module: commonjs`. É inofensivo e já acontece em prisma/*.ts e scripts/*.ts:
// specs ficam FORA do tsconfig.build.json, que é o que o `npm run build` e o CI
// compilam. Quem resolve este arquivo é o Vite, não o tsc.)
// `**` (e não `*`) para não pular silenciosamente `contracts/<subpasta>/*`: um
// glob não-recursivo passaria em branco se alguém organizasse os contratos em
// subpastas amanhã — exatamente o tipo de "cobertura que promete mas não
// cumpre" que esta guarda existe para evitar.
const modulosDeContrato = import.meta.glob<Record<string, unknown>>(
  './contracts/**/*.schema.ts',
  { eager: true },
);

// Deliberadamente `src/**` e não `src/modules/**/dto/**`: o que define um DTO é
// o sufixo do arquivo, não a pasta onde alguém resolveu colocá-lo. Mas veja o
// limite documentado acima (varredura 2): isto só alcança DTOs EXPORTADOS de
// arquivos `*.dto.ts`. Quem fecha o buraco de DTOs inline/não-exportados é a
// varredura 3 (describe 'controllers reais', mais abaixo).
const modulosDeDto = import.meta.glob<Record<string, unknown>>(
  '../**/*.dto.ts',
  { eager: true },
);

// Todo `*.controller.ts` da árvore, para a varredura 3 (describe mais abaixo).
const modulosDeController = import.meta.glob<Record<string, unknown>>(
  '../**/*.controller.ts',
  { eager: true },
);

/** Um schema zod v4 é reconhecido pela marca `_zod` — é o mesmo teste que o
 *  nestjs-zod usa para decidir entre o caminho v4 e o v3. */
function ehSchemaZod(valor: unknown): boolean {
  return (
    (typeof valor === 'object' || typeof valor === 'function') &&
    valor !== null &&
    '_zod' in valor
  );
}

/** Uma classe criada por `createZodDto` se identifica por `isZodDto`. */
type ZodDto = { _OPENAPI_METADATA_FACTORY: () => unknown };
function ehZodDto(valor: unknown): valor is ZodDto {
  return (
    typeof valor === 'function' &&
    'isZodDto' in valor &&
    (valor as { isZodDto?: unknown }).isZodDto === true &&
    '_OPENAPI_METADATA_FACTORY' in valor
  );
}

/** Um controller Nest real se identifica pela mesma marca que o próprio
 *  framework usa para reconhecer `@Controller()` (`CONTROLLER_WATERMARK`,
 *  gravada via `Reflect.defineMetadata` pelo decorator) — não uma
 *  reimplementação da checagem, o mesmo teste que o `DependenciesScanner` do
 *  `@nestjs/core` faz. */
type NestControllerClass = new (...args: never[]) => unknown;
function ehController(valor: unknown): valor is NestControllerClass {
  return (
    typeof valor === 'function' &&
    Reflect.getMetadata(CONTROLLER_WATERMARK, valor) === true
  );
}

// O rótulo de cada caso é `arquivo → export`, para o relatório do vitest
// apontar o culpado pelo nome em vez de dizer só "caso #37".
const schemasDeContrato: Array<[string, unknown]> = [];
for (const [caminho, mod] of Object.entries(modulosDeContrato)) {
  for (const [nomeDoExport, valor] of Object.entries(mod)) {
    if (ehSchemaZod(valor)) {
      schemasDeContrato.push([`${caminho} → ${nomeDoExport}`, valor]);
    }
  }
}

const dtos: Array<[string, ZodDto]> = [];
for (const [caminho, mod] of Object.entries(modulosDeDto)) {
  for (const [nomeDoExport, valor] of Object.entries(mod)) {
    if (ehZodDto(valor)) {
      dtos.push([`${caminho} → ${nomeDoExport}`, valor]);
    }
  }
}

const controllers: Array<[string, NestControllerClass]> = [];
for (const [caminho, mod] of Object.entries(modulosDeController)) {
  for (const [nomeDoExport, valor] of Object.entries(mod)) {
    if (ehController(valor)) {
      controllers.push([`${caminho} → ${nomeDoExport}`, valor]);
    }
  }
}

describe('OpenAPI — todo schema de contrato é representável em JSON Schema', () => {
  // Sem isto, um glob quebrado (renomearam a pasta, mudou o padrão do nome do
  // arquivo) transformaria a varredura em lista vazia e o teste passaria
  // VERDE sem checar nada. O número é um piso folgado, não a contagem exata.
  it('a varredura encontrou schemas (senão o teste é decorativo)', () => {
    expect(schemasDeContrato.length).toBeGreaterThan(50);
  });

  it.each(schemasDeContrato)('%s', (_nome, schema) => {
    // `io: 'input'` é o eixo que o nestjs-zod usa nos DTOs, e é o eixo onde o
    // `z.coerce.date()` explode (a ENTRADA dele é `Date`). Testar 'output'
    // aqui não pegaria o bug.
    expect(() =>
      toJSONSchema(schema as Parameters<typeof toJSONSchema>[0], {
        io: 'input',
      }),
    ).not.toThrow();
  });
});

describe('OpenAPI — todo DTO gera metadata sem lançar', () => {
  it('a varredura encontrou DTOs (senão o teste é decorativo)', () => {
    expect(dtos.length).toBeGreaterThan(40);
  });

  // Aqui não reimplementamos nada: `_OPENAPI_METADATA_FACTORY` é exatamente o
  // que o @nestjs/swagger invoca em cada DTO ao montar o documento. Cobre
  // também os DTOs cujo schema é declarado inline no próprio .dto.ts e que,
  // por isso, escapam da varredura de contracts/.
  it.each(dtos)('%s', (_nome, dto) => {
    expect(() => dto._OPENAPI_METADATA_FACTORY()).not.toThrow();
  });
});

describe('OpenAPI — o documento real, com todo controller da árvore, é gerado sem lançar', () => {
  // Mesmo piso de sanidade que as duas varreduras acima: um glob quebrado não
  // pode virar uma lista vazia e um teste verde-por-omissão.
  it('a varredura encontrou controllers (senão o teste é decorativo)', () => {
    expect(controllers.length).toBeGreaterThan(15);
  });

  // Este é o teste que fecha o buraco que as duas varreduras acima não
  // fecham: um DTO declarado inline num controller, sem export, sem sufixo
  // `.dto.ts` — nada que dependa de "importar a classe pelo nome" alcança
  // esse caso, porque não existe binding exportado para importar. A saída é
  // não depender de nomes: construir um app Nest de verdade com TODO
  // controller real (via `useMocker` para não precisar de Postgres/Redis/env
  // — não estamos testando os PROVIDERS, só a FORMA das rotas) e rodar o
  // mesmíssimo `SwaggerModule.createDocument` que `mountApiDocs` (main.ts)
  // chama no boot. Precedente: `main.spec.ts` já reproduz esta exata falha
  // ("Date cannot be represented in JSON Schema") com um app Nest real; aqui
  // é o mesmo caminho, generalizado para toda a árvore em vez de dois
  // controllers de fixture.
  it(
    'SwaggerModule.createDocument não lança para nenhum controller real da árvore',
    async () => {
      const moduleRef = await Test.createTestingModule({
        controllers: controllers.map(([, ctrl]) => ctrl),
      })
        // Não injetamos providers reais (Prisma, filas, HTTP clients de
        // provedor) de propósito: gerar o documento OpenAPI só precisa da
        // FORMA da classe (decorators de rota + tipos de DTO), nunca invoca
        // um handler. `useMocker` satisfaz qualquer dependência de
        // construtor com um objeto vazio, o que é suficiente para a árvore
        // de DI fechar sem tocar banco/fila/rede.
        .useMocker(() => ({}))
        .compile();

      const app = moduleRef.createNestApplication();
      await app.init();

      try {
        const config = new DocumentBuilder()
          .setTitle('guarda-representabilidade')
          .build();
        expect(() => SwaggerModule.createDocument(app, config)).not.toThrow();
      } finally {
        await app.close();
      }
    },
  );
});
