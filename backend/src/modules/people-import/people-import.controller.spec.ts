import type { INestApplication } from '@nestjs/common';
import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_PIPE } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import type { Role } from '@prisma/client';
import type { Response } from 'express';
import { ZodValidationPipe } from 'nestjs-zod';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  permissionsWith,
  type PermissionChange,
} from '../../shared/authz/actor.test-fixtures';
import { AuditService } from '../../shared/audit/audit.service';
import { DomainExceptionFilter } from '../../shared/errors/domain-exception.filter';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { IMPORT_MAX_BYTES } from '../../shared/spreadsheet/sheet-data';
import { UserThrottlerGuard } from '../../shared/throttler/user-throttler.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RolesGuard } from '../auth/roles.guard';
import { PermissionsService } from '../permissions/permissions.service';
import { UsersModule } from '../users/users.module';
import { UsersRepository } from '../users/users.repository';
import { UsersService } from '../users/users.service';
import { PeopleImportConfirmService } from './people-import-confirm.service';
import { PeopleImportFilesService } from './people-import-files.service';
import { PeopleImportPreviewService } from './people-import-preview.service';
import { PeopleImportQueryService } from './people-import-query.service';
import { PeopleImportWriterService } from './people-import-writer.service';
import { PeopleImportController } from './people-import.controller';
import { batchNotFound } from './people-import.errors';
import { PeopleImportModule } from './people-import.module';

const ACTOR = 'user_1';
const BASE = '/internal/people-import';
const BATCHES = `${BASE}/batches`;
const BATCH = `${BATCHES}/batch_1`;
const SUMMARY = { id: 'batch_1' };
const CSV = Buffer.from('Nome;Telefone\nAna Teste;+5592991110001\n');
const MAPPING = {
  registration: null,
  name: 0,
  phone: 1,
  jobTitle: null,
  sector: null,
  shift: null,
  level: null,
  authorization: null,
  authorizationSource: null,
  authorizationNote: null,
  authorizationDate: null,
};

type Mocks = ReturnType<typeof serviceMocks>;
type Server = Parameters<typeof request>[0];

function serviceMocks() {
  const resolved = () => vi.fn().mockResolvedValue(SUMMARY);
  return {
    preview: { upload: resolved(), remap: resolved(), discard: vi.fn() },
    query: { list: resolved(), summary: resolved(), rows: resolved() },
    files: { template: vi.fn(), errorReport: vi.fn() },
    confirmation: { confirm: resolved(), close: resolved() },
    writer: { writeBlock: resolved() },
  };
}

/** Ator do JWT (o header `x-test-user` troca o usuário) com o papel do app. */
function authenticateAs(role: Role) {
  return {
    canActivate: (ctx: {
      switchToHttp(): {
        getRequest(): { user?: unknown; headers: Record<string, string> };
      };
    }) => {
      const req = ctx.switchToHttp().getRequest();
      req.user = { sub: req.headers['x-test-user'] ?? ACTOR, role };
      return true;
    },
  };
}

function serviceProviders(mocks: Mocks) {
  return [
    { provide: PeopleImportPreviewService, useValue: mocks.preview },
    { provide: PeopleImportQueryService, useValue: mocks.query },
    { provide: PeopleImportFilesService, useValue: mocks.files },
    { provide: PeopleImportConfirmService, useValue: mocks.confirmation },
    { provide: PeopleImportWriterService, useValue: mocks.writer },
  ];
}

const openApps: INestApplication[] = [];

/**
 * O app na ordem real: ator, `RolesGuard`, `PermissionsGuard` (matriz padrão
 * do papel mais `change`), `UserThrottlerGuard` (memória, teto global de 100),
 * pipe Zod e filtro globais.
 */
async function importApp(role: Role = 'ADMIN', change: PermissionChange = {}) {
  const mocks = serviceMocks();
  const effectiveFor = (r: Role) => Promise.resolve(permissionsWith(r, change));
  const moduleRef = await Test.createTestingModule({
    imports: [
      ThrottlerModule.forRoot({ throttlers: [{ ttl: 60_000, limit: 100 }] }),
    ],
    controllers: [PeopleImportController],
    providers: [
      ...serviceProviders(mocks),
      { provide: ConfigService, useValue: { get: () => undefined } },
      { provide: PermissionsService, useValue: { effectiveFor } },
      { provide: APP_PIPE, useClass: ZodValidationPipe },
      { provide: APP_FILTER, useClass: DomainExceptionFilter },
      { provide: APP_GUARD, useValue: authenticateAs(role) },
      { provide: APP_GUARD, useClass: RolesGuard },
      { provide: APP_GUARD, useClass: PermissionsGuard },
      { provide: APP_GUARD, useClass: UserThrottlerGuard },
    ],
  }).compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  openApps.push(app);
  return { server: app.getHttpServer() as Server, mocks };
}

/** O serviço entrega o arquivo escrevendo na resposta que recebeu. */
function sendFile(...args: unknown[]): void {
  const res = args.at(-1) as Response;
  res.setHeader('Content-Disposition', 'attachment; filename="x.csv"');
  res.end('arquivo');
}

function uploadCsv(server: Server, name = 'pessoas.csv', user = ACTOR) {
  return request(server)
    .post(BATCHES)
    .set('x-test-user', user)
    .attach('file', CSV, name);
}

/** Toda chamada feita a algum serviço falso. */
function serviceCalls(mocks: Mocks): unknown[] {
  return Object.values(mocks).flatMap((service) =>
    Object.values(service).flatMap((fn) => fn.mock.calls),
  );
}

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

describe('PeopleImportController — campo de texto no multipart (T21 M1)', () => {
  it('campo de texto, com ou sem arquivo → 400 do multer e o serviço não é chamado', async () => {
    const { server, mocks } = await importApp();

    const alone = await request(server).post(BATCHES).field('outro', 'valor');
    const withFile = await request(server)
      .post(BATCHES)
      .field('outro', 'valor')
      .attach('file', CSV, 'a.csv');

    expect([alone.status, withFile.status]).toEqual([400, 400]);
    expect(mocks.preview.upload).not.toHaveBeenCalled();
  });
});

describe('PeopleImportController — envio da planilha', () => {
  it('envio repassa o arquivo e o id do usuário ao serviço', async () => {
    const { server, mocks } = await importApp();

    const res = await uploadCsv(server, 'Relação.csv');

    expect(res.status).toBe(201);
    expect(res.body).toEqual(SUMMARY);
    expect(mocks.preview.upload).toHaveBeenCalledWith(ACTOR, {
      // cru, como o multer entrega (latin1); quem converte é o serviço (EX4)
      originalName: Buffer.from('Relação.csv').toString('latin1'),
      size: CSV.length,
      buffer: CSV,
    });
  });

  it('interceptor troca o 413 do multer por 422 com o texto da spec', async () => {
    const { server, mocks } = await importApp();

    const res = await request(server)
      .post(BATCHES)
      .attach('file', Buffer.alloc(IMPORT_MAX_BYTES + 1), 'grande.csv');

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      code: 'people_import.file_too_large',
      detail: 'O arquivo passa de 5 MB. Divida a planilha e envie em partes.',
    });
    expect(mocks.preview.upload).not.toHaveBeenCalled();
  });

  it('pedido sem arquivo responde 422 invalid_file e o serviço não é chamado', async () => {
    const { server, mocks } = await importApp();

    const res = await request(server).post(BATCHES);

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      code: 'people_import.invalid_file',
      detail: 'Envie um arquivo .csv ou .xlsx.',
    });
    expect(mocks.preview.upload).not.toHaveBeenCalled();
  });
});

describe('PeopleImportController — multipart fora do contrato', () => {
  it.each([
    [
      'campo com outro nome',
      (r: request.Test) => r.attach('arquivo', CSV, 'a.csv'),
    ],
    [
      'dois arquivos',
      (r: request.Test) =>
        r.attach('file', CSV, 'a.csv').attach('file', CSV, 'b.csv'),
    ],
  ])('%s → 400 do multer e o serviço não é chamado', async (_case, build) => {
    const { server, mocks } = await importApp();

    const res = await build(request(server).post(BATCHES));

    expect(res.status).toBe(400);
    expect(mocks.preview.upload).not.toHaveBeenCalled();
  });
});

describe('PeopleImportController — modelo e relatório de erros', () => {
  it('modelo e relatório escrevem na resposta', async () => {
    const { server, mocks } = await importApp();
    mocks.files.template.mockImplementation(sendFile);
    mocks.files.errorReport.mockImplementation(sendFile);

    const template = await request(server).get(`${BASE}/template?format=xlsx`);
    const report = await request(server).get(`${BATCH}/errors.csv`);

    for (const res of [template, report]) {
      expect(res.status).toBe(200);
      expect(res.headers['content-disposition']).toContain('attachment');
      expect(res.text).toBe('arquivo');
    }
    expect(mocks.files.template).toHaveBeenCalledWith(
      'xlsx',
      expect.anything(),
    );
    expect(mocks.files.errorReport).toHaveBeenCalledWith(
      ACTOR,
      'batch_1',
      expect.anything(),
    );
  });

  it('relatório negado (403) ou de lote invisível (404) não manda header nem byte do arquivo', async () => {
    const viewer = await importApp('VIEWER');
    const admin = await importApp();
    admin.mocks.files.errorReport.mockRejectedValue(batchNotFound());

    const denied = await request(viewer.server).get(`${BATCH}/errors.csv`);
    const missing = await request(admin.server).get(`${BATCH}/errors.csv`);

    expect([denied.status, missing.status]).toEqual([403, 404]);
    for (const res of [denied, missing]) {
      expect(res.headers['content-disposition']).toBeUndefined();
      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.text).not.toContain('arquivo');
    }
    expect(viewer.mocks.files.errorReport).not.toHaveBeenCalled();
  });
});

describe('PeopleImportController — rotas de ação e leitura', () => {
  it('rotas de ação repassam id do lote e corpo validado', async () => {
    const { server, mocks } = await importApp();
    const confirmBody = {
      createNew: true,
      updateExisting: false,
      mapping: MAPPING,
    };

    const replies = [
      await request(server).put(`${BATCH}/mapping`).send({ mapping: MAPPING }),
      await request(server).post(`${BATCH}/confirm`).send(confirmBody),
      await request(server).post(`${BATCH}/write`),
      await request(server).post(`${BATCH}/close`),
    ];
    const discarded = await request(server).delete(BATCH);

    expect(replies.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    expect(replies.map((r) => r.body as unknown)).toEqual(
      Array(4).fill(SUMMARY),
    );
    expect(discarded.status).toBe(204);
    expect(mocks.preview.remap).toHaveBeenCalledWith(ACTOR, 'batch_1', MAPPING);
    expect(mocks.confirmation.confirm).toHaveBeenCalledWith(ACTOR, 'batch_1', {
      ...confirmBody,
      excludedRows: [],
    });
    expect(mocks.writer.writeBlock).toHaveBeenCalledWith(ACTOR, 'batch_1');
    expect(mocks.confirmation.close).toHaveBeenCalledWith(ACTOR, 'batch_1');
    expect(mocks.preview.discard).toHaveBeenCalledWith(ACTOR, 'batch_1');
  });

  it('leituras repassam id do lote e a query validada', async () => {
    const { server, mocks } = await importApp();

    const replies = [
      await request(server).get(`${BATCHES}?page=2`),
      await request(server).get(BATCH),
      await request(server).get(`${BATCH}/rows?page=3&classification=CREATE`),
    ];

    expect(replies.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(mocks.query.list).toHaveBeenCalledWith(ACTOR, { page: 2 });
    expect(mocks.query.summary).toHaveBeenCalledWith(ACTOR, 'batch_1');
    expect(mocks.query.rows).toHaveBeenCalledWith(ACTOR, 'batch_1', {
      page: 3,
      classification: 'CREATE',
    });
  });
});

describe('PeopleImportController — corpo e query inválidos (pipe Zod global)', () => {
  it.each([
    ['put', `${BATCH}/mapping`, { mapping: { ...MAPPING, phone: 0 } }],
    ['put', `${BATCH}/mapping`, { mapping: { name: 0 } }],
    ['put', `${BATCH}/mapping`, { mapping: { ...MAPPING, extra: 2 } }],
    ['post', `${BATCH}/confirm`, { updateExisting: true }],
    [
      'post',
      `${BATCH}/confirm`,
      {
        createNew: true,
        updateExisting: true,
        mapping: MAPPING,
        excludedRows: [1],
      },
    ],
    ['get', `${BATCH}/rows?classification=OUTRA`, undefined],
    ['get', `${BATCHES}?page=0`, undefined],
    ['get', `${BASE}/template?format=pdf`, undefined],
    ['get', `${BASE}/template`, undefined],
  ] as const)(
    '%s %s %j → 400 e nenhum serviço é chamado',
    async (method, path, body) => {
      const { server, mocks } = await importApp();

      const res = await request(server)[method](path).send(body);

      expect(res.status).toBe(400);
      expect(serviceCalls(mocks)).toEqual([]);
    },
  );
});

/** As onze rotas de CX1, cada uma com o pedido mínimo que o handler aceitaria. */
const ROUTES = [
  ['get', `${BASE}/template?format=csv`],
  ['get', BATCHES],
  ['post', BATCHES],
  ['get', BATCH],
  ['put', `${BATCH}/mapping`],
  ['get', `${BATCH}/rows`],
  ['post', `${BATCH}/confirm`],
  ['post', `${BATCH}/write`],
  ['post', `${BATCH}/close`],
  ['delete', BATCH],
  ['get', `${BATCH}/errors.csv`],
] as const;

describe('PeopleImportController — chave pessoas.importar em todas as rotas', () => {
  it.each(['VIEWER', 'OPERATOR', 'SUPERVISOR'] as const)(
    '%s sem a chave recebe 403 auth.permission_denied nas onze rotas, sem chamar serviço',
    async (role) => {
      const { server, mocks } = await importApp(role);

      const replies: { status: number; body: unknown }[] = [];
      for (const [method, path] of ROUTES) {
        replies.push(await request(server)[method](path));
      }

      for (const res of replies) {
        expect(res.status).toBe(403);
        expect(res.body).toMatchObject({
          code: 'auth.permission_denied',
          detail: 'Você não tem permissão para importar planilhas de pessoas.',
        });
      }
      expect(serviceCalls(mocks)).toEqual([]);
    },
  );

  it('ADMIN sem a chave na matriz é recusado no /write; OPERATOR com a chave passa', async () => {
    const revoked = await importApp('ADMIN', { revoke: ['pessoas.importar'] });
    const granted = await importApp('OPERATOR', {
      grant: ['pessoas.importar'],
    });

    const denied = await request(revoked.server).post(`${BATCH}/write`);
    const allowed = await request(granted.server).post(`${BATCH}/write`);

    expect(denied.status).toBe(403);
    expect(revoked.mocks.writer.writeBlock).not.toHaveBeenCalled();
    expect(allowed.status).toBe(200);
    expect(granted.mocks.writer.writeBlock).toHaveBeenCalledWith(
      ACTOR,
      'batch_1',
    );
  });
});

describe('PeopleImportController — limite de 10 envios por minuto por usuário', () => {
  const remap = (server: Server, user: string) =>
    request(server)
      .put(`${BATCH}/mapping`)
      .set('x-test-user', user)
      .send({ mapping: MAPPING });
  const send = (server: Server, user: string) =>
    uploadCsv(server, 'pessoas.csv', user);

  it.each([
    ['envio', send, 201],
    ['remapear', remap, 200],
  ] as const)(
    '%s: o 11º do mesmo usuário recebe 429 e outro usuário ainda passa',
    async (_route, call, ok) => {
      const { server } = await importApp();

      const first: number[] = [];
      for (let i = 0; i < 11; i += 1) {
        first.push((await call(server, 'user_a')).status);
      }
      const other = await call(server, 'user_b');

      expect(first.slice(0, 10)).toEqual(Array(10).fill(ok));
      expect(first[10]).toBe(429);
      expect(other.status).toBe(ok);
    },
  );
});

describe('PeopleImportModule — injeção de dependências', () => {
  it('compila com os providers reais e injeta todos os serviços no controller', async () => {
    @Global()
    @Module({
      providers: [
        { provide: PrismaService, useValue: {} },
        { provide: AuditService, useValue: {} },
      ],
      exports: [PrismaService, AuditService],
    })
    class FakeGlobals {}
    @Module({
      providers: [
        { provide: UsersService, useValue: {} },
        { provide: UsersRepository, useValue: {} },
      ],
      exports: [UsersService, UsersRepository],
    })
    class FakeUsers {}

    const moduleRef = await Test.createTestingModule({
      imports: [FakeGlobals, PeopleImportModule],
    })
      .overrideModule(UsersModule)
      .useModule(FakeUsers)
      .compile();
    const controller = moduleRef.get(PeopleImportController);

    const injected = controller as unknown as Record<string, unknown>;
    expect(injected.writer).toBeInstanceOf(PeopleImportWriterService);
    expect(injected.preview).toBeInstanceOf(PeopleImportPreviewService);
    expect(injected.query).toBeInstanceOf(PeopleImportQueryService);
    expect(injected.files).toBeInstanceOf(PeopleImportFilesService);
    expect(injected.confirmation).toBeInstanceOf(PeopleImportConfirmService);
    await moduleRef.close();
  });
});
