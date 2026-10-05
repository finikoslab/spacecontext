import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc', environment: 'dev' },
      remoteBindings: false,
      miniflare: {
        bindings: {
          PUBLIC_URL: 'https://mcp.example.test',
          API_BASE_URL: 'https://api.example.test/v1',
        },
      },
    }),
  ],
  test: { include: ['test/**/*.test.ts'] },
});
