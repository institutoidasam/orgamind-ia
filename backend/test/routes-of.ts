import { RequestMethod, type Type } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';

/** Normaliza um path de handler: sempre com `/` na frente (`''` vira `/`). */
function normalizePath(path: unknown): string {
  const raw = typeof path === 'string' ? path : '';
  return raw.startsWith('/') ? raw : `/${raw}`;
}

/**
 * Lista as rotas HTTP declaradas num controller como `'<MÉTODO> /<path>'`, sem
 * o prefixo do controller (ex.: `'GET /zernio/accounts'`, `'DELETE /channels/:id'`).
 * Lê `PATH_METADATA` e `METHOD_METADATA` dos handlers: serve para provar que uma
 * rota deixou de existir sem subir o app.
 */
export function routesOf(controller: Type<unknown>): string[] {
  const proto = controller.prototype as Record<string, unknown>;
  return Object.getOwnPropertyNames(proto).flatMap((name) => {
    const handler = proto[name];
    if (name === 'constructor' || typeof handler !== 'function') return [];
    const method = Reflect.getMetadata(METHOD_METADATA, handler) as
      RequestMethod | undefined;
    if (method === undefined) return [];
    const metadata: unknown = Reflect.getMetadata(PATH_METADATA, handler);
    const paths = Array.isArray(metadata) ? metadata : [metadata];
    return paths.map(
      (path) => `${RequestMethod[method]} ${normalizePath(path)}`,
    );
  });
}
