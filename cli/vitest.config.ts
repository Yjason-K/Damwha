import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

// build.mjs와 같은 값을 넣는다 — src/version.ts 참고.
const { version } = JSON.parse(readFileSync(new URL('../desktop/package.json', import.meta.url), 'utf8')) as { version: string };

export default defineConfig({
  define: { __DAMWHA_VERSION__: JSON.stringify(version) },
});
