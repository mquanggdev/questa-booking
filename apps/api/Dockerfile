# Build context: repo root (docker compose sets it). One image serves the API
# and, from phase 4, the worker; only the start command differs.

FROM node:24-alpine AS base
RUN npm install -g pnpm@12.8.1
WORKDIR /repo

# ---- deps + build (also used for one-off tasks such as the seed) ----
FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/prisma.config.ts apps/api/
COPY apps/api/prisma apps/api/prisma
RUN pnpm install --frozen-lockfile --filter @questa/api...
COPY apps/api apps/api
# auto-install-peers=false: @prisma/client and others declare optional peers
# (the prisma CLI, typescript) that the running app never loads. Without
# it, they and their dependencies (Prisma Studio, PGlite...) make up half
# of node_modules: 451 MB -> 207 MB (phase 9).
RUN pnpm --filter @questa/api build \
 && pnpm deploy --filter @questa/api --prod --legacy \
      --config.auto-install-peers=false /out \
 && cp -r apps/api/dist /out/dist

# ---- runtime: production deps + compiled code only ----
FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out ./
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]

# ---- migrate: only the Prisma CLI, the schema and the migrations ----
# Runs `prisma migrate deploy` before the API starts (docker compose service
# "migrate", and the deploy). The build stage would do too, but weighs
# ~2.8 GB to pull on the server for one command.
FROM node:24-alpine AS migrate
WORKDIR /app
RUN npm install --omit=dev --no-audit --no-fund prisma@7.10.0 \
 && npm cache clean --force
COPY --chown=node:node apps/api/prisma.config.ts ./
COPY --chown=node:node apps/api/prisma/schema.prisma ./prisma/schema.prisma
COPY --chown=node:node apps/api/prisma/migrations ./prisma/migrations
USER node
CMD ["npx", "prisma", "migrate", "deploy"]
