import node from '@astrojs/node';
import react from '@astrojs/react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'astro/config';

export default defineConfig({
  output: 'server',
  site: process.env.SITE_URL || 'http://localhost:4321',
  adapter: node({ mode: 'standalone', bodySizeLimit: 10 * 1024 * 1024 }),
  integrations: [react()],
  // Origin is checked for every state-changing request in src/middleware.ts
  // (against SITE_URL, which is correct behind the Fly proxy).
  security: { checkOrigin: false },
  server: { host: true },
  vite: {
    ssr: { external: ['better-sqlite3', 'sharp'] },
    resolve: {
      alias: {
        // Islands import the matcher directly so zod (pulled in by the package index) stays out of the client bundle.
        '@cojiro/shared/normalize': fileURLToPath(new URL('../../packages/shared/src/normalize.ts', import.meta.url)),
      },
    },
  },
});
