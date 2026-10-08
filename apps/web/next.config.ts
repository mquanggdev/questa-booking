import type { NextConfig } from 'next';
import { fileURLToPath } from 'node:url';

// Where the Next.js server reaches the API: http://api:3000 inside Docker,
// http://localhost:3100 on the host in development. Read when the server
// starts (dev) or when the image is built (production).
const apiUrl = process.env.API_INTERNAL_URL ?? 'http://localhost:3100';

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  typedRoutes: true,
  // A self-contained server (.next/standalone) for a small Docker image.
  output: 'standalone',
  // pnpm keeps dependencies at the monorepo root; trace from there.
  outputFileTracingRoot: fileURLToPath(new URL('../../', import.meta.url)),
  // The browser only ever talks to this origin: /api/* is forwarded to the
  // API, so the httpOnly refresh cookie (path /api/v1/auth) works and no CORS
  // is needed. In production a reverse proxy may route /api directly instead.
  rewrites() {
    return [{ source: '/api/:path*', destination: `${apiUrl}/api/:path*` }];
  },
  turbopack: {
    rules: {
      '*.css': {
        loaders: ['@tailwindcss/turbopack'],
        as: '*.css',
      },
    },
  },
};

export default nextConfig;
