# Build context: repo root (docker compose sets it). One image serves the API
# and, from phase 4, the worker; only the start command differs.

FROM node:24-alpine AS base
RUN npm install -g pnpm@12.8.1
WORKDIR /repo

# ---- deps + build (also used for one-off tasks: migrations, seed) ----
FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/prisma.config.ts apps/api/
COPY apps/api/prisma apps/api/prisma
RUN pnpm install --frozen-lockfile --filter @questa/api...
COPY apps/api apps/api
RUN pnpm --filter @questa/api build \
 && pnpm deploy --filter @questa/api --prod --legacy /out \
 && cp -r apps/api/dist /out/dist

# ---- runtime: production deps + compiled code only ----
FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out ./
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
