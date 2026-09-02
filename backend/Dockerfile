FROM node:22-alpine AS deps
RUN apk add --no-cache curl bash unzip libstdc++ \
 && curl -fsSL https://bun.sh/install | bash \
 && ln -s /root/.bun/bin/bun /usr/local/bin/bun
WORKDIR /app
# O nome do lockfile e LITERAL de proposito. Antes era `bun.lockb*`, glob do
# formato binario antigo do bun, que nao casa com o `bun.lock` (texto) que o
# repo versiona: a imagem era construida SEM lockfile nenhum e o
# `--frozen-lockfile` abaixo, sem nada pra congelar, resolvia tudo do zero a
# cada build. Prod nao era reproduzivel e divergia das versoes que o CI testa.
# Sem glob, se o arquivo sumir o build FALHA alto — que e o que a gente quer,
# em vez de voltar a silenciosamente resolver do registry.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate && npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
RUN addgroup -g 1001 nodejs && adduser -S -u 1001 -G nodejs nestjs
COPY --from=build --chown=nestjs:nodejs /app/dist ./dist
COPY --from=build --chown=nestjs:nodejs /app/node_modules ./node_modules
COPY --from=build --chown=nestjs:nodejs /app/prisma ./prisma
# Operational scripts (contact export/import/verify) run inside this container
# during a DB cutover — see docs/superpowers/specs/2026-07-10-provider-capability-addendum.md §5.
COPY --from=build --chown=nestjs:nodejs /app/scripts ./scripts
# The TS that runs via `tsx` at RUNTIME (`npx prisma db seed` on every deploy,
# and the ops scripts above) imports from `src/` — e.g. the seed composes the
# consent text from `src/modules/consent/consent-text.composer`. Without the
# sources in the image, `prisma db seed` dies on an unresolved import and the
# deploy's migrate job fails. `tsconfig.json` comes along because tsx reads it.
COPY --from=build --chown=nestjs:nodejs /app/src ./src
COPY --chown=nestjs:nodejs tsconfig.json ./
COPY --chown=nestjs:nodejs package.json ./
USER nestjs
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:3000/health/live || exit 1
CMD ["node", "dist/main.js"]
