# @questa/web

The buyer-facing web app of Questa Booking (Next.js 16, App Router). See the
[root README](../../README.md) for the whole project.

```bash
pnpm --filter @questa/web dev            # http://localhost:3200, API at API_INTERNAL_URL
pnpm --filter @questa/web api:types      # regenerate src/lib/api/schema.d.ts from ../api/openapi.json
pnpm --filter @questa/web test:browser   # Playwright, needs the stack running and seeded
```

- `/api/*` is forwarded to the API (`next.config.ts`), so the browser only
  ever talks to one origin and the httpOnly refresh cookie just works.
- Catalog pages render on the server; buying, orders and tickets run in the
  browser with TanStack Query and a typed client generated from OpenAPI.
- The seat map draws on a canvas (react-konva).
