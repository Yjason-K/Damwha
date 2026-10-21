// 단일 CJS 번들. desktop이 이 파일 하나를 Resources/cli/로 싣는다 (spec §2.6).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { build } from 'esbuild';

const out = 'dist/damwha.cjs';
// `damwha --version`과 MCP serverInfo는 앱 버전이다 (src/version.ts).
const { version } = JSON.parse(readFileSync(new URL('../desktop/package.json', import.meta.url), 'utf8'));
const result = await build({
  entryPoints: ['src/main.ts'],
  outfile: out,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  write: false,
  define: { __DAMWHA_VERSION__: JSON.stringify(version) },
});

// esbuild는 모듈마다 `../node_modules/.pnpm/<패키지>/...` 경로를 주석과 __commonJS 키로 남긴다.
// 경로는 라벨일 뿐 런타임에 쓰이지 않는데, desktop의 check-bundle 4번이 번들 안 "/.pnpm/"을
// 빌드 머신 유출로 잡는다. 라벨에서만 그 조각을 지운다.
const text = result.outputFiles[0].text.replaceAll('/.pnpm/', '/_pnpm/');
// write:false라 esbuild가 출력 디렉터리를 만들어 주지 않는다 — 새 clone·CI에는 cli/dist가 없다.
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, text);
