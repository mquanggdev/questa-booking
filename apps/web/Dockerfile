# Build context: repo root (docker compose sets it). Next.js "standalone"
# output: a self-contained Node server with only the files it needs.

FROM node:24-alpine AS base
RUN npm install -g pnpm@12.8.1
WORKDIR /repo

FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter @questa/web...
COPY apps/web apps/web
# The /api rewrite target is fixed at build time (next.config.ts).
ARG API_INTERNAL_URL=http://api:3000
ENV API_INTERNAL_URL=$API_INTERNAL_URL \
    NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter @questa/web build

FROM node:24-alpine AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
# outputFileTracingRoot is the repo root, so the server sits in apps/web/.
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /repo/apps/web/public ./apps/web/public
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
